/**
 * 0agent telegram — Start the Telegram bot listener.
 *
 * Runs in the foreground with live logs.
 * Receives messages via long polling, submits each as a task
 * to the runtime, and sends the result back to the Telegram chat.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const CONFIG_DIR = join(homedir(), '.0agent');
const ENV_PATH = join(CONFIG_DIR, '.env');

function loadConfig(key: string): string | null {
    // Try .env file
    if (existsSync(ENV_PATH)) {
        const content = readFileSync(ENV_PATH, 'utf-8');
        const regex = new RegExp(`^${key}=(.+)$`, 'm');
        const match = content.match(regex);
        if (match && match[1] && match[1].trim().length > 0) {
            return match[1].trim();
        }
    }

    // Try environment variable
    if (process.env[key]) {
        return process.env[key]!;
    }

    return null;
}

export const telegramCommand = new Command('telegram')
    .description('Start Telegram bot listener (message in → task → reply out)')
    .action(async () => {
        console.log('');
        console.log(chalk.bold.cyan('  ⬡ 0agent Telegram listener'));
        console.log('');

        const token = loadConfig('TELEGRAM_BOT_TOKEN');
        const authorizedUserId = loadConfig('TELEGRAM_USER_ID');

        if (!token) {
            console.log(chalk.red('  No Telegram Bot Token found.'));
            console.log('');
            console.log('  To set one up:');
            console.log(chalk.dim('    1. Open Telegram, search for @BotFather'));
            console.log(chalk.dim('    2. Send /newbot and follow the prompts'));
            console.log(chalk.dim('    3. Copy the token and run: 0agent onboard'));
            console.log('');
            process.exit(1);
        }

        // Dynamically import the listener (it lives in the runtime package but
        // can be used standalone since it only uses ws and fetch)
        const { TelegramListener } = await import(
            // @ts-expect-error — cross-package import resolved at runtime
            '../../runtime/src/adapters/telegram-listener.js'
        ).catch(() => {
            // Fallback: inline a minimal listener
            return { TelegramListener: null };
        });

        if (!TelegramListener) {
            // Inline minimal listener if cross-package import fails
            await runInlineListener(token, authorizedUserId);
            return;
        }

        const listener = new TelegramListener(token, authorizedUserId);

        // Handle graceful shutdown
        process.on('SIGINT', () => {
            listener.stop();
            console.log('');
            process.exit(0);
        });
        process.on('SIGTERM', () => {
            listener.stop();
            process.exit(0);
        });

        await listener.start();
    });

/**
 * Inline listener fallback — used when the cross-package import doesn't resolve.
 * Same logic as TelegramListener but self-contained using only ws and fetch.
 */
async function runInlineListener(botToken: string, authorizedUserId: string | null): Promise<void> {
    const TELEGRAM_API = 'https://api.telegram.org';
    const WS_URL = 'ws://localhost:3000/ws';

    // Verify bot
    const meRes = await fetch(`${TELEGRAM_API}/bot${botToken}/getMe`);
    const me = (await meRes.json()) as { ok: boolean; result?: { username: string; first_name: string } };

    if (!me.ok || !me.result) {
        console.log(chalk.red('  Invalid bot token. Get a new one from @BotFather.'));
        process.exit(1);
    }

    console.log(`  Bot: ${chalk.cyan('@' + me.result.username)} (${me.result.first_name})`);
    console.log(chalk.dim('  Listening for messages... (Ctrl+C to stop)\n'));

    let offset = 0;
    let running = true;

    process.on('SIGINT', () => { running = false; process.exit(0); });
    process.on('SIGTERM', () => { running = false; process.exit(0); });

    const { default: WebSocket } = await import('ws');

    while (running) {
        try {
            const res = await fetch(
                `${TELEGRAM_API}/bot${botToken}/getUpdates?offset=${offset}&timeout=30`,
                { signal: AbortSignal.timeout(40000) }
            );
            const body = (await res.json()) as {
                ok: boolean; result?: Array<{
                    update_id: number;
                    message?: { chat: { id: number; first_name?: string }; text?: string };
                }>
            };

            if (!body.ok || !body.result) continue;

            for (const update of body.result) {
                offset = update.update_id + 1;
                const msg = update.message;
                if (!msg?.text) continue;

                const chatId = msg.chat.id;
                const userName = msg.chat.first_name ?? 'User';
                const text = msg.text;

                if (authorizedUserId && chatId.toString() !== authorizedUserId) {
                    console.log(chalk.dim(`  ← Blocking unauthorized user ${userName} (${chatId})`));
                    continue;
                }

                console.log(chalk.dim(`  ← ${userName}: ${text}`));

                // Submit task via WebSocket
                const response = await new Promise<string | null>((resolve) => {
                    const timer = setTimeout(() => resolve(null), 60000);
                    const ws = new WebSocket(WS_URL);
                    let result = '';

                    ws.on('open', () => {
                        ws.send(JSON.stringify({ type: 'task', payload: { task: text } }));
                    });
                    ws.on('message', (data: Buffer) => {
                        try {
                            const m = JSON.parse(data.toString()) as { type: string; chunk?: string };
                            if (m.type === 'stream' && m.chunk) result += m.chunk;
                            if (m.type === 'done') { clearTimeout(timer); ws.close(); resolve(result || '(done)'); }
                            if (m.type === 'error') { clearTimeout(timer); ws.close(); resolve(null); }
                        } catch { /* ignore */ }
                    });
                    ws.on('error', () => { clearTimeout(timer); resolve(null); });
                });

                // Reply on Telegram
                const reply = response ?? 'Sorry, I couldn\'t process that right now.';
                const truncated = reply.length > 4000 ? reply.slice(0, 4000) + '\n...(truncated)' : reply;
                await fetch(`${TELEGRAM_API}/bot${botToken}/sendMessage`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ chat_id: chatId, text: truncated }),
                });
                console.log(chalk.dim(`  → ${userName}: ${truncated.slice(0, 80)}${truncated.length > 80 ? '...' : ''}`));
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.log(chalk.yellow(`  Poll error: ${msg}`));
            await new Promise(r => setTimeout(r, 5000));
        }
    }
}
