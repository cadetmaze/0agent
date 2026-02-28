/**
 * TelegramAdapter — Send messages via Telegram Bot API.
 *
 * Implements the CapabilityAdapter interface.
 * Scope: send a text message to a chat. No media, groups, or inline keyboards.
 */

import type {
    CapabilityAdapter,
    CapabilityManifest,
    ValidatedInput,
    AdapterResult,
    AdapterError,
    ErrorContext,
    HealthStatus,
} from './base.js';
import type { InjectedCredentials } from './key-proxy.js';

const TELEGRAM_API = 'https://api.telegram.org';

export class TelegramAdapter implements CapabilityAdapter {
    manifest(): CapabilityManifest {
        return {
            id: 'telegram',
            name: 'Telegram Messaging',
            description: 'Send text messages via Telegram Bot API',
            version: '0.1.0',
            inputSchema: {
                type: 'object',
                properties: {
                    action: { type: 'string', description: 'Action: send_message' },
                    chatId: { type: 'string', description: 'Telegram chat ID to send to' },
                    text: { type: 'string', description: 'Message text to send' },
                },
                required: ['action', 'chatId', 'text'],
            },
            outputSchema: {
                type: 'object',
                properties: {
                    ok: { type: 'boolean' },
                    messageId: { type: 'number' },
                },
            },
            requiresCredentials: ['TELEGRAM_BOT_TOKEN'],
            sideEffects: 'irreversible',
        };
    }

    async execute(
        input: ValidatedInput,
        _credentials: InjectedCredentials
    ): Promise<AdapterResult> {
        const startTime = Date.now();
        const token = process.env['TELEGRAM_BOT_TOKEN'] ?? '';
        const chatId = input.data['chatId'] as string;
        const text = input.data['text'] as string;

        if (!token) {
            return {
                success: false,
                data: { error: 'TELEGRAM_BOT_TOKEN not configured' },
                metadata: {
                    durationMs: Date.now() - startTime,
                    adapterId: 'telegram',
                    timestamp: new Date().toISOString(),
                },
            };
        }

        try {
            const res = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: chatId,
                    text,
                    parse_mode: 'Markdown',
                }),
            });

            const body = (await res.json()) as { ok: boolean; result?: { message_id: number }; description?: string };

            if (!body.ok) {
                return {
                    success: false,
                    data: { error: body.description ?? 'Unknown Telegram error' },
                    metadata: {
                        durationMs: Date.now() - startTime,
                        adapterId: 'telegram',
                        timestamp: new Date().toISOString(),
                    },
                };
            }

            return {
                success: true,
                data: {
                    ok: true,
                    messageId: body.result?.message_id,
                },
                metadata: {
                    durationMs: Date.now() - startTime,
                    adapterId: 'telegram',
                    timestamp: new Date().toISOString(),
                },
            };
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return {
                success: false,
                data: { error: message },
                metadata: {
                    durationMs: Date.now() - startTime,
                    adapterId: 'telegram',
                    timestamp: new Date().toISOString(),
                },
            };
        }
    }

    async health(): Promise<HealthStatus> {
        const token = process.env['TELEGRAM_BOT_TOKEN'];
        if (!token) {
            return {
                healthy: false,
                adapterId: 'telegram',
                lastChecked: new Date().toISOString(),
                details: 'TELEGRAM_BOT_TOKEN not set',
            };
        }

        try {
            const res = await fetch(`${TELEGRAM_API}/bot${token}/getMe`);
            const body = (await res.json()) as { ok: boolean };
            return {
                healthy: body.ok,
                adapterId: 'telegram',
                lastChecked: new Date().toISOString(),
                details: body.ok ? 'Bot token valid' : 'Invalid bot token',
            };
        } catch {
            return {
                healthy: false,
                adapterId: 'telegram',
                lastChecked: new Date().toISOString(),
                details: 'Failed to reach Telegram API',
            };
        }
    }

    errorContext(error: AdapterError): ErrorContext {
        return {
            error,
            suggestedAction: error.retriable ? 'retry' : 'escalate',
            retryDelayMs: 3000,
            maxRetries: 2,
            humanReadableExplanation: `Telegram send failed: ${error.message}`,
        };
    }
}
