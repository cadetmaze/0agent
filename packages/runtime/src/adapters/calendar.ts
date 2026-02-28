/**
 * CalendarAdapter — Google Calendar API stub.
 *
 * In production, uses the Google Calendar API to create, read, update,
 * and delete calendar events.
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

export class CalendarAdapter implements CapabilityAdapter {
    manifest(): CapabilityManifest {
        return {
            id: 'google-calendar',
            name: 'Google Calendar',
            description: 'Create, read, update, and delete calendar events via Google Calendar API',
            version: '0.1.0',
            inputSchema: {
                type: 'object',
                properties: {
                    action: { type: 'string', description: 'Action: create | read | update | delete | list' },
                    eventId: { type: 'string', description: 'Event ID (for read/update/delete)' },
                    summary: { type: 'string', description: 'Event title (for create/update)' },
                    description: { type: 'string', description: 'Event description' },
                    startTime: { type: 'string', description: 'ISO start time' },
                    endTime: { type: 'string', description: 'ISO end time' },
                    attendees: { type: 'array', items: { type: 'string' }, description: 'Attendee emails' },
                },
                required: ['action'],
            },
            outputSchema: {
                type: 'object',
                properties: {
                    eventId: { type: 'string' },
                    events: { type: 'array', items: { type: 'object' } },
                    success: { type: 'boolean' },
                },
            },
            requiresCredentials: ['google_calendar_oauth'],
            sideEffects: 'reversible',
            estimatedCostPerCall: 0,
        };
    }

    async execute(
        input: ValidatedInput,
        credentials: InjectedCredentials
    ): Promise<AdapterResult> {
        const startTime = Date.now();

        if (!credentials._injected) {
            throw new Error('[CalendarAdapter] Credentials not injected by Key Proxy');
        }

        // TODO: Implement Google Calendar API calls using googleapis package.
        console.log(`[CalendarAdapter] ${input.data['action']} (stub)`);

        return {
            success: true,
            data: {
                eventId: `stub-event-${Date.now()}`,
                events: [],
                success: true,
            },
            metadata: {
                durationMs: Date.now() - startTime,
                adapterId: 'google-calendar',
                timestamp: new Date().toISOString(),
            },
        };
    }

    async health(): Promise<HealthStatus> {
        return {
            healthy: true,
            adapterId: 'google-calendar',
            lastChecked: new Date().toISOString(),
            details: 'Stub adapter — always healthy',
        };
    }

    errorContext(error: AdapterError): ErrorContext {
        return {
            error,
            suggestedAction: error.retriable ? 'retry' : 'escalate',
            retryDelayMs: 2000,
            maxRetries: 2,
            humanReadableExplanation: `Calendar operation failed: ${error.message}`,
        };
    }
}
