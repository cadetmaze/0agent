/**
 * SlackAdapter — Slack API stub.
 *
 * In production, uses the Slack Web API to send messages, read channels,
 * manage threads, and react to messages.
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

export class SlackAdapter implements CapabilityAdapter {
    manifest(): CapabilityManifest {
        return {
            id: 'slack',
            name: 'Slack',
            description: 'Send messages, read channels, manage threads via Slack Web API',
            version: '0.1.0',
            inputSchema: {
                type: 'object',
                properties: {
                    action: { type: 'string', description: 'Action: send_message | read_channel | reply_thread | react' },
                    channel: { type: 'string', description: 'Channel ID or name' },
                    message: { type: 'string', description: 'Message text' },
                    threadTs: { type: 'string', description: 'Thread timestamp (for reply_thread)' },
                    emoji: { type: 'string', description: 'Emoji name (for react)' },
                },
                required: ['action', 'channel'],
            },
            outputSchema: {
                type: 'object',
                properties: {
                    messageTs: { type: 'string' },
                    messages: { type: 'array', items: { type: 'object' } },
                    success: { type: 'boolean' },
                },
            },
            requiresCredentials: ['slack_bot_token'],
            sideEffects: 'irreversible',
            estimatedCostPerCall: 0,
        };
    }

    async execute(
        input: ValidatedInput,
        credentials: InjectedCredentials
    ): Promise<AdapterResult> {
        const startTime = Date.now();

        if (!credentials._injected) {
            throw new Error('[SlackAdapter] Credentials not injected by Key Proxy');
        }

        // TODO: Implement Slack Web API calls using @slack/web-api package.
        console.log(
            `[SlackAdapter] ${input.data['action']} on ${input.data['channel']} (stub)`
        );

        return {
            success: true,
            data: {
                messageTs: `stub-${Date.now()}`,
                messages: [],
                success: true,
            },
            metadata: {
                durationMs: Date.now() - startTime,
                adapterId: 'slack',
                timestamp: new Date().toISOString(),
            },
        };
    }

    async health(): Promise<HealthStatus> {
        return {
            healthy: true,
            adapterId: 'slack',
            lastChecked: new Date().toISOString(),
            details: 'Stub adapter — always healthy',
        };
    }

    errorContext(error: AdapterError): ErrorContext {
        return {
            error,
            suggestedAction: error.retriable ? 'retry' : 'escalate',
            retryDelayMs: 2000,
            maxRetries: 3,
            humanReadableExplanation: `Slack operation failed: ${error.message}`,
        };
    }
}
