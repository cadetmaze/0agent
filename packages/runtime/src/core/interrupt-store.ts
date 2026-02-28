/**
 * InterruptStore — Redis-backed task interrupt/resume mechanism.
 *
 * Any task can be halted by any source (user, policy engine, budget engine,
 * confidence gate). The orchestrator checks interrupt state before every
 * tool execution. Halting is instantaneous; resuming restores from the last
 * checkpoint written to working_memory.
 *
 * Redis key schema: interrupt:{taskId}  →  halt reason (TTL: 1 hour)
 */

import type IORedis from 'ioredis';

// ============================================================
// Types
// ============================================================

export type HaltReason = 'user' | 'policy' | 'confidence' | 'budget' | 'circuit_breaker';

export interface HaltRecord {
    reason: HaltReason;
    haltedAt: string;    // ISO timestamp
    message?: string;
}

export interface InterruptState {
    isHalted: boolean;
    record?: HaltRecord;
}

export class TaskInterruptedError extends Error {
    readonly taskId: string;
    readonly reason: HaltReason;

    constructor(taskId: string, reason: HaltReason, message?: string) {
        super(message ?? `Task ${taskId} interrupted by ${reason}`);
        this.name = 'TaskInterruptedError';
        this.taskId = taskId;
        this.reason = reason;
    }
}

// ============================================================
// InterruptStore
// ============================================================

const KEY_PREFIX = 'interrupt:';
const DEFAULT_TTL_SECONDS = 3600; // 1 hour

export class InterruptStore {
    constructor(private readonly redis: IORedis) { }

    /**
     * Halt a task. The next interrupt check in the orchestrator will throw
     * TaskInterruptedError and log the halt event.
     */
    async halt(
        taskId: string,
        reason: HaltReason,
        message?: string
    ): Promise<void> {
        const record: HaltRecord = {
            reason,
            haltedAt: new Date().toISOString(),
            ...(message ? { message } : {}),
        };

        await this.redis.set(
            `${KEY_PREFIX}${taskId}`,
            JSON.stringify(record),
            'EX',
            DEFAULT_TTL_SECONDS
        );
    }

    /**
     * Clear the halt signal, allowing the task to resume.
     * The orchestrator's resumeTask() method calls this before rehydrating.
     */
    async resume(taskId: string): Promise<void> {
        await this.redis.del(`${KEY_PREFIX}${taskId}`);
    }

    /**
     * Check whether a task is currently halted. Called before every tool
     * execution in the orchestrator. Fast path: returns false immediately
     * if Redis returns null.
     */
    async isHalted(taskId: string): Promise<boolean> {
        const val = await this.redis.get(`${KEY_PREFIX}${taskId}`);
        return val !== null;
    }

    /**
     * Return the full halt record if the task is halted, or null otherwise.
     */
    async getState(taskId: string): Promise<InterruptState> {
        const val = await this.redis.get(`${KEY_PREFIX}${taskId}`);
        if (val === null) return { isHalted: false };

        try {
            const record = JSON.parse(val) as HaltRecord;
            return { isHalted: true, record };
        } catch {
            // Corrupted key — treat as not halted, clean up
            await this.redis.del(`${KEY_PREFIX}${taskId}`);
            return { isHalted: false };
        }
    }

    /**
     * Guard: throw TaskInterruptedError if the task is halted.
     * Drop this call before every tool invocation in the orchestrator.
     *
     * @example
     *   await this.interruptStore.guardOrThrow(taskId);
     *   // safe to execute tool call below
     */
    async guardOrThrow(taskId: string): Promise<void> {
        const state = await this.getState(taskId);
        if (state.isHalted && state.record) {
            throw new TaskInterruptedError(
                taskId,
                state.record.reason,
                state.record.message
            );
        }
    }

    /**
     * List all currently halted task IDs. Used by the CLI `0agent status`
     * command to show paused tasks.
     */
    async listHalted(): Promise<string[]> {
        const keys = await this.redis.keys(`${KEY_PREFIX}*`);
        return keys.map((k) => k.replace(KEY_PREFIX, ''));
    }
}
