/**
 * Logger — Append-only event stream for telemetry.
 *
 * All agent actions, LLM calls, adapter executions, and policy decisions
 * are logged to the telemetry_events table. This table is append-only —
 * UPDATE and DELETE are blocked by a database trigger.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { scanForCredentialLeaks } from '../adapters/key-proxy.js';

// ============================================================
// Types
// ============================================================

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface TelemetryEvent {
    companyId: string;
    agentId: string;
    taskId?: string;
    eventType: string;
    payload: Record<string, unknown>;
    costTokens?: number;
    costDollars?: number;
    latencyMs?: number;
    success?: boolean;
    confidenceScore?: number;
}

// ============================================================
// Logger
// ============================================================

export class Logger {
    private supabase: SupabaseClient;
    private logLevel: LogLevel;
    private buffer: TelemetryEvent[] = [];
    private flushIntervalMs: number;
    private flushTimer: ReturnType<typeof setInterval> | null = null;

    constructor(
        supabase: SupabaseClient,
        logLevel: LogLevel = 'info',
        flushIntervalMs: number = 5000
    ) {
        this.supabase = supabase;
        this.logLevel = logLevel;
        this.flushIntervalMs = flushIntervalMs;
    }

    /**
     * Start the periodic flush loop.
     */
    start(): void {
        if (this.flushTimer) return;

        this.flushTimer = setInterval(() => {
            void this.flush();
        }, this.flushIntervalMs);

        console.log(`[Logger] Started with ${this.flushIntervalMs}ms flush interval`);
    }

    /**
     * Stop the flush loop and flush remaining events.
     */
    async stop(): Promise<void> {
        if (this.flushTimer) {
            clearInterval(this.flushTimer);
            this.flushTimer = null;
        }
        await this.flush();
        console.log('[Logger] Stopped');
    }

    /**
     * Log a telemetry event.
     * Scans payload for credential leaks before logging.
     */
    log(event: TelemetryEvent): void {
        // Scan for credential leaks in the payload
        const payloadStr = JSON.stringify(event.payload);
        const leakScan = scanForCredentialLeaks(payloadStr);

        if (leakScan.hasLeak) {
            console.error(
                `[Logger] CREDENTIAL LEAK DETECTED in event "${event.eventType}":`,
                leakScan.leakedPatterns
            );
            // Redact the payload
            event = {
                ...event,
                payload: {
                    ...event.payload,
                    _redacted: true,
                    _originalPayloadRedacted: leakScan.redactedPayload,
                },
            };
        }

        this.buffer.push(event);

        // Also log to console at appropriate level
        const message = `[${event.eventType}] agent=${event.agentId} task=${event.taskId ?? 'none'} success=${event.success ?? 'n/a'}`;
        this.consoleLog('info', message);
    }

    /**
     * Convenience methods for structured logging.
     */
    debug(agentId: string, message: string, data?: Record<string, unknown>): void {
        this.consoleLog('debug', `[${agentId}] ${message}`);
        if (data) {
            this.log({
                companyId: '',
                agentId,
                eventType: 'debug',
                payload: { message, ...data },
            });
        }
    }

    info(agentId: string, message: string, data?: Record<string, unknown>): void {
        this.consoleLog('info', `[${agentId}] ${message}`);
        this.log({
            companyId: '',
            agentId,
            eventType: 'info',
            payload: { message, ...data },
        });
    }

    warn(agentId: string, message: string, data?: Record<string, unknown>): void {
        this.consoleLog('warn', `[${agentId}] ${message}`);
        this.log({
            companyId: '',
            agentId,
            eventType: 'warning',
            payload: { message, ...data },
        });
    }

    error(agentId: string, message: string, data?: Record<string, unknown>): void {
        this.consoleLog('error', `[${agentId}] ${message}`);
        this.log({
            companyId: '',
            agentId,
            eventType: 'error',
            payload: { message, ...data },
        });
    }

    /**
     * Flush buffered events to the database.
     */
    async flush(): Promise<void> {
        if (this.buffer.length === 0) return;

        const events = [...this.buffer];
        this.buffer = [];

        const rows = events.map((e) => ({
            company_id: e.companyId,
            agent_id: e.agentId,
            task_id: e.taskId ?? null,
            event_type: e.eventType,
            payload: e.payload,
            cost_tokens: e.costTokens ?? null,
            cost_dollars: e.costDollars ?? null,
            latency_ms: e.latencyMs ?? null,
            success: e.success ?? null,
            confidence_score: e.confidenceScore ?? null,
        }));

        const { error } = await this.supabase.from('telemetry_events').insert(rows);

        if (error) {
            // Silence "fetch failed" in logs — it's expected in local mode and very noisy
            if (error.message.includes('fetch failed')) {
                // Don't log anything to console
            } else {
                console.error(`[Logger] Failed to flush ${rows.length} events: ${error.message}`);
            }
            // Put events back in the buffer for retry
            this.buffer.unshift(...events);
        }
    }

    // ============================================================
    // Private
    // ============================================================

    private consoleLog(level: LogLevel, message: string): void {
        const levels: Record<LogLevel, number> = {
            debug: 0,
            info: 1,
            warn: 2,
            error: 3,
        };

        if (levels[level]! >= levels[this.logLevel]!) {
            const timestamp = new Date().toISOString();
            switch (level) {
                case 'debug':
                    console.debug(`${timestamp} [DEBUG] ${message}`);
                    break;
                case 'info':
                    console.log(`${timestamp} [INFO] ${message}`);
                    break;
                case 'warn':
                    console.warn(`${timestamp} [WARN] ${message}`);
                    break;
                case 'error':
                    console.error(`${timestamp} [ERROR] ${message}`);
                    break;
            }
        }
    }
}
