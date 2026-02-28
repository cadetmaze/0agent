/**
 * MeasurementHook — Post-task trigger for the RL update loop.
 *
 * Called by the Orchestrator after every task completes.
 * Assembles the TaskExecutionEvent from telemetry and fires
 * ReinforcementEngine.update() asynchronously (non-blocking).
 *
 * Never delays task completion — RL updates happen in the background.
 */

import { ReinforcementEngine } from './reinforcement-engine.js';
import type { TaskExecutionEvent } from './reward-calculator.js';
import type { LensedResult } from '../core/envelope.js';
import type { TaskDefinition } from '../core/envelope.js';

export interface TaskCompletionContext {
    taskId: string;
    agentId: string;
    companyId: string;
    task: TaskDefinition;
    providerId: string;
    costDollars: number;
    budgetDollars: number;
    latencyMs: number;
    lensedResult: LensedResult;
    escalated: boolean;
    escalationConfirmed: boolean;
    humanOverride: boolean;
    aplDelta: number;  // NaN if APL not yet computed
}

export class MeasurementHook {
    constructor(private engine: ReinforcementEngine) { }

    /**
     * Fire the RL update after a successful task completion.
     * Non-blocking: queues the update and returns immediately.
     */
    onTaskCompleted(ctx: TaskCompletionContext): void {
        const event: TaskExecutionEvent = {
            taskId: ctx.taskId,
            agentId: ctx.agentId,
            companyId: ctx.companyId,
            taskType: this.inferTaskType(ctx.task.spec),
            providerId: ctx.providerId,
            costDollars: ctx.costDollars,
            budgetDollars: ctx.budgetDollars,
            confidenceScore: ctx.lensedResult.confidenceScore,
            success: !ctx.lensedResult.constraintViolation,
            escalated: ctx.escalated,
            escalationConfirmed: ctx.escalationConfirmed,
            humanOverride: ctx.humanOverride,
            aplDelta: ctx.aplDelta,
            latencyMs: ctx.latencyMs,
        };

        // Fire-and-forget — RL update never blocks task pipeline
        void this.engine.update(event).catch((err) => {
            console.error(
                `[MeasurementHook] RL update failed for task ${ctx.taskId}: ` +
                (err instanceof Error ? err.message : String(err))
            );
        });
    }

    /**
     * Infer task type from spec (mirrors LLMRouter.classifyTask logic).
     * Kept simple here — in production the orchestrator should pass the
     * already-classified task type.
     */
    private inferTaskType(spec: string): string {
        const lower = spec.toLowerCase();
        if (['password', 'credential', 'ssn', 'private key'].some((kw) => lower.includes(kw))) {
            return 'sensitive';
        }
        if (['analyze', 'evaluate', 'recommend', 'strategy', 'decision'].some((kw) => lower.includes(kw))) {
            return 'judgment_heavy';
        }
        if (spec.length < 200 && ['format', 'convert', 'extract', 'list'].some((kw) => lower.includes(kw))) {
            return 'fast';
        }
        return 'standard';
    }
}
