/**
 * TelegramListener — Long-polling listener for Telegram messages.
 *
 * Runs on the host (NOT inside Docker). Connects to the runtime
 * via WebSocket to submit incoming messages as tasks.
 *
 * Flow: Telegram message → WebSocket task → LLM response → Telegram reply
 */

const TELEGRAM_API = 'https://api.telegram.org';

interface TelegramUpdate {
    update_id: number;
    message?: {
        message_id: number;
        chat: { id: number; first_name?: string; username?: string };
        text?: string;
        date: number;
    };
}

interface TelegramResponse {
    ok: boolean;
    result?: TelegramUpdate[];
    description?: string;
}

interface WsMessage {
    type: string;
    chunk?: string;
}

export class TelegramListener {
    private botToken: string;
    private runtimeUrl: string;
    private authorizedUserId: string | null;
    private running = false;
    private offset = 0;
    private onLog: (msg: string) => void;

    constructor(
        botToken: string,
        authorizedUserId: string | null = null,
        runtimeUrl: string = 'ws://localhost:3000/ws',
        onLog?: (msg: string) => void
    ) {
        this.botToken = botToken;
        this.authorizedUserId = authorizedUserId;
        this.runtimeUrl = runtimeUrl;
        this.onLog = onLog ?? ((msg: string) => console.log(`[Telegram] ${msg}`));
    }

    async start(): Promise<void> {
        this.running = true;
        this.onLog('Starting Telegram listener (long polling)...');

        // Verify bot token
        const me = await this.getMe();
        if (!me) {
            this.onLog('ERROR: Invalid bot token. Get one from @BotFather on Telegram.');
            return;
        }
        this.onLog(`Bot: @${me.username} (${me.first_name})`);
        this.onLog('Listening for messages... (Ctrl+C to stop)\n');

        while (this.running) {
            try {
                await this.pollOnce();
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                this.onLog(`Poll error: ${msg}`);
                // Back off on error
                await this.sleep(5000);
            }
        }
    }

    stop(): void {
        this.running = false;
        this.onLog('Stopping...');
    }

    // ============================================================
    // Private
    // ============================================================

    private async pollOnce(): Promise<void> {
        const res = await fetch(
            `${TELEGRAM_API}/bot${this.botToken}/getUpdates?offset=${this.offset}&timeout=30`,
            { signal: AbortSignal.timeout(40000) }
        );
        const body = (await res.json()) as TelegramResponse;

        if (!body.ok || !body.result) return;

        for (const update of body.result) {
            this.offset = update.update_id + 1;

            if (update.message?.text) {
                const userId = update.message.chat.id.toString();
                if (this.authorizedUserId && userId !== this.authorizedUserId) {
                    this.onLog(`Blocked message from unauthorized user ID: ${userId}`);
                    continue;
                }

                await this.handleMessage(
                    update.message.chat.id,
                    update.message.text,
                    update.message.chat.first_name ?? 'User'
                );
            }
        }
    }

    private async handleMessage(chatId: number, text: string, userName: string): Promise<void> {
        console.log(`\n[Telegram] ← Incoming from ${userName} (${chatId}): "${text}"`);

        // Submit as task via WebSocket
        const response = await this.submitTask(text);

        // Send response back to Telegram
        if (response) {
            await this.sendMessage(chatId, response);
            console.log(`[Telegram] → Response to ${userName}: "${response.slice(0, 100)}${response.length > 100 ? '...' : ''}"`);
        } else {
            await this.sendMessage(chatId, 'Sorry, I couldn\'t process that right now. Try again.');
            console.log(`[Telegram] → Response to ${userName}: (error - no response generated)`);
        }
    }

    private submitTask(taskSpec: string): Promise<string | null> {
        return new Promise((resolve) => {
            const timeout = setTimeout(() => resolve(null), 60000);

            try {
                // Dynamic import ws for the CLI context
                import('ws').then(({ default: WebSocket }) => {
                    const ws = new WebSocket(this.runtimeUrl);
                    let responseText = '';

                    ws.on('open', () => {
                        ws.send(JSON.stringify({
                            type: 'task',
                            payload: { task: taskSpec },
                        }));
                    });

                    ws.on('message', (data: Buffer) => {
                        try {
                            const msg = JSON.parse(data.toString()) as WsMessage;
                            if (msg.type === 'stream' && msg.chunk) {
                                responseText += msg.chunk;
                            }
                            if (msg.type === 'done') {
                                clearTimeout(timeout);
                                ws.close();
                                resolve(responseText || '(Task completed)');
                            }
                            if (msg.type === 'error') {
                                clearTimeout(timeout);
                                ws.close();
                                resolve(null);
                            }
                        } catch { /* ignore parse errors */ }
                    });

                    ws.on('error', () => {
                        clearTimeout(timeout);
                        resolve(null);
                    });
                }).catch(() => {
                    clearTimeout(timeout);
                    resolve(null);
                });
            } catch {
                clearTimeout(timeout);
                resolve(null);
            }
        });
    }

    private async sendMessage(chatId: number, text: string): Promise<void> {
        // Truncate if too long for Telegram (max 4096 chars)
        const truncated = text.length > 4000 ? text.slice(0, 4000) + '\n\n...(truncated)' : text;

        await fetch(`${TELEGRAM_API}/bot${this.botToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                text: truncated,
            }),
        });
    }

    private async getMe(): Promise<{ username: string; first_name: string } | null> {
        try {
            const res = await fetch(`${TELEGRAM_API}/bot${this.botToken}/getMe`);
            const body = (await res.json()) as {
                ok: boolean;
                result?: { username: string; first_name: string };
            };
            return body.ok ? body.result ?? null : null;
        } catch {
            return null;
        }
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(r => setTimeout(r, ms));
    }
}
