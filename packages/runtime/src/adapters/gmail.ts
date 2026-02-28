/**
 * GmailAdapter — Gmail API stub.
 *
 * In production, uses the Gmail API to send, read, search, and label emails.
 * All credentials are injected by the Key Proxy — never handled directly.
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

export class GmailAdapter implements CapabilityAdapter {
    manifest(): CapabilityManifest {
        return {
            id: 'gmail',
            name: 'Gmail',
            description: 'Send, read, search, and label emails via Gmail API',
            version: '0.1.0',
            inputSchema: {
                type: 'object',
                properties: {
                    action: { type: 'string', description: 'Action: send | read | search | label' },
                    to: { type: 'string', description: 'Recipient email (for send)' },
                    subject: { type: 'string', description: 'Email subject (for send)' },
                    body: { type: 'string', description: 'Email body (for send)' },
                    query: { type: 'string', description: 'Search query (for search)' },
                    messageId: { type: 'string', description: 'Message ID (for read/label)' },
                    label: { type: 'string', description: 'Label to apply (for label)' },
                },
                required: ['action'],
            },
            outputSchema: {
                type: 'object',
                properties: {
                    messageId: { type: 'string' },
                    messages: { type: 'array', items: { type: 'object' } },
                    success: { type: 'boolean' },
                },
            },
            requiresCredentials: ['gmail_oauth'],
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
            throw new Error('[GmailAdapter] Credentials not injected by Key Proxy');
        }

        // TODO: Implement Gmail API calls using googleapis package.
        // Use OAuth2 tokens from the Key Proxy.
        console.log(`[GmailAdapter] ${input.data['action']} (stub)`);

        return {
            success: true,
            data: {
                messageId: `stub-msg-${Date.now()}`,
                messages: [],
                success: true,
            },
            metadata: {
                durationMs: Date.now() - startTime,
                adapterId: 'gmail',
                timestamp: new Date().toISOString(),
            },
        };
    }

    async health(): Promise<HealthStatus> {
        return {
            healthy: true,
            adapterId: 'gmail',
            lastChecked: new Date().toISOString(),
            details: 'Stub adapter — always healthy',
        };
    }

    errorContext(error: AdapterError): ErrorContext {
        return {
            error,
            suggestedAction: error.retriable ? 'retry' : 'escalate',
            retryDelayMs: 3000,
            maxRetries: 2,
            humanReadableExplanation: `Gmail operation failed: ${error.message}. Check OAuth credentials.`,
        };
    }
}
