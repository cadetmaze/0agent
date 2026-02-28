/**
 * ReinforcementEngine — Q-learning update loop for adaptive execution.
 *
 * Implements contextual bandit Q-update:
 *   Q_new = Q_old + alpha * (reward - Q_old)
 *
 * Updates three parameters per task completion:
 *   1. Router Q-weights per provider
 *   2. Escalation threshold delta
 *   3. Budget multiplier
 *
 * Safety Guardrails (MUST NOT be bypassed):
 *   1. Freeze on reward volatility (variance > 0.6 over last 10 updates)
 *   2. Halve alpha if APL drops for >= 5 consecutive tasks
 *   3. Abort if any param would violate a hard policy constraint
 *   4. Cap per-update delta at 10% of param range
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
    AdaptivePolicyStore,
    type AdaptiveParams,
    PARAM_BOUNDS,
} from './adaptive-policy-store.js';
import { RewardCalculator, type TaskExecutionEvent, type RewardVector } from './reward-calculator.js';
import type { TaskClassification } from '../router/llm-router.js';

// ============================================================
// Types
// ============================================================

export interface EngineConfig {
    /** Base learning rate. Default: 0.05 */
    baseAlpha: number;
    /** Variance threshold above which adaptation freezes. Default: 0.6 */
    freezeVarianceThreshold: number;
    /** Number of consecutive APL drops before reducing alpha. Default: 5 */
    alphDecayDropCount: number;
    /** Factor by which alpha is halved when APL drops consistently. Default: 0.5 */
    alphaDecayFactor: number;
    /** Max fraction of param range that can change per update. Default: 0.10 */
    maxDeltaFraction: number;
}

const DEFAULT_ENGINE_CONFIG: EngineConfig = {
    baseAlpha: 0.05,
    freezeVarianceThreshold: 0.6,
    alphDecayDropCount: 5,
    alphaDecayFactor: 0.5,
    maxDeltaFraction: 0.10,
};

// ============================================================
// ReinforcementEngine
// ============================================================

export class ReinforcementEngine {
    private config: EngineConfig;
    private calculator: RewardCalculator;
    private store: AdaptivePolicyStore;

    /** Rolling window of recent rewards per (agentId, taskType) for volatility tracking */
    private rewardHistory: Map<string, number[]> = new Map();
    /** Consecutive APL-drop counter per (agentId, taskType) */
    private aplDropCounter: Map<string, number> = new Map();

    constructor(
        private supabase: SupabaseClient,
        config?: Partial<EngineConfig>
    ) {
        this.config = { ...DEFAULT_ENGINE_CONFIG, ...config };
        this.calculator = new RewardCalculator();
        this.store = new AdaptivePolicyStore(supabase);
    }

    // ============================================================
    // Public API
    // ============================================================

    /**
     * Process a task completion event. Computes reward and updates params.
     * This is the core RL update loop.
     * Non-blocking — errors are logged, never thrown.
     */
    async update(event: TaskExecutionEvent): Promise<void> {
        try {
            await this.doUpdate(event);
        } catch (err) {
            console.error(
                `[ReinforcementEngine] Update failed for task ${event.taskId}: ` +
                (err instanceof Error ? err.message : String(err))
            );
        }
    }

    // ============================================================
    // Private — Core Update
    // ============================================================

    private async doUpdate(event: TaskExecutionEvent): Promise<void> {
        const taskType = event.taskType as TaskClassification;
        const key = `${event.agentId}:${taskType}`;

        // 1. Load current params
        const params = await this.store.load(event.companyId, event.agentId, taskType);

        // 2. Skip if frozen
        if (params.frozen) {
            console.log(`[ReinforcementEngine] Skipping update — params frozen for ${key}`);
            return;
        }

        // 3. Compute reward vector
        const reward = this.calculator.compute(event);

        // 4. Safety check: reward volatility → freeze
        const shouldFreeze = this.checkVolatility(key, reward.total, params);
        if (shouldFreeze) {
            await this.store.freeze(
                event.companyId,
                event.agentId,
                taskType,
                `Reward volatility exceeded threshold (${this.config.freezeVarianceThreshold})`
            );
            await this.logAudit(event, reward, params, params, params.alpha, true,
                'volatility_freeze');
            return;
        }

        // 5. Track APL drops → decay alpha
        const effectiveAlpha = this.computeEffectiveAlpha(key, event, params.alpha);

        // 6. Compute new params via Q-update
        const updated = this.qUpdate(params, reward, event, effectiveAlpha);

        // 7. Persist
        await this.store.save(event.companyId, event.agentId, taskType, updated);

        // 8. Immutable audit log
        await this.logAudit(event, reward, params, updated, effectiveAlpha, false);

        console.log(
            `[ReinforcementEngine] Updated ${key}: total_reward=${reward.total.toFixed(3)}, ` +
            `alpha=${effectiveAlpha.toFixed(4)}, updateCount=${updated.updateCount}`
        );
    }

    // ============================================================
    // Q-Update
    // ============================================================

    private qUpdate(
        params: AdaptiveParams,
        reward: RewardVector,
        event: TaskExecutionEvent,
        alpha: number
    ): AdaptiveParams {
        const r = reward.total;

        // --- Escalation threshold delta ---
        const currentEscalation = params.escalationThresholdDelta;
        const range = PARAM_BOUNDS.escalationThresholdDelta.max - PARAM_BOUNDS.escalationThresholdDelta.min;
        const escalationDelta = alpha * (r - currentEscalation);
        const cappedEscalationDelta = this.capDelta(escalationDelta, range);
        const newEscalation = AdaptivePolicyStore.clamp(
            'escalationThresholdDelta',
            currentEscalation + cappedEscalationDelta
        );

        // --- Budget multiplier ---
        const costReward = reward.costEfficiency;
        const currentBudget = params.budgetMultiplier;
        const budgetRange = PARAM_BOUNDS.budgetMultiplier.max - PARAM_BOUNDS.budgetMultiplier.min;
        const budgetDelta = alpha * (costReward - (currentBudget - 1.0)); // normalize around 0
        const cappedBudgetDelta = this.capDelta(budgetDelta, budgetRange);
        const newBudget = AdaptivePolicyStore.clamp(
            'budgetMultiplier',
            currentBudget + cappedBudgetDelta
        );

        // --- Router Q-weights ---
        const newRouterWeights = { ...params.routerWeights };
        const currentProviderQ = newRouterWeights[event.providerId] ?? 0;
        const providerRange = PARAM_BOUNDS.routerQValue.max - PARAM_BOUNDS.routerQValue.min;
        const providerDelta = alpha * (r - currentProviderQ);
        const cappedProviderDelta = this.capDelta(providerDelta, providerRange);
        newRouterWeights[event.providerId] = AdaptivePolicyStore.clampQValue(
            currentProviderQ + cappedProviderDelta
        );

        return {
            ...params,
            routerWeights: newRouterWeights,
            escalationThresholdDelta: newEscalation,
            budgetMultiplier: newBudget,
            alpha,
            updateCount: params.updateCount + 1,
        };
    }

    // ============================================================
    // Safety Guardrails
    // ============================================================

    private checkVolatility(
        key: string,
        reward: number,
        params: AdaptiveParams
    ): boolean {
        const history = this.rewardHistory.get(key) ?? [];
        history.push(reward);

        // Keep rolling window of 10
        if (history.length > 10) history.shift();
        this.rewardHistory.set(key, history);

        if (history.length < 5) return false; // Not enough data

        const mean = history.reduce((a, b) => a + b, 0) / history.length;
        const variance =
            history.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0) / history.length;

        if (variance > this.config.freezeVarianceThreshold) {
            console.warn(
                `[ReinforcementEngine] High reward volatility (variance=${variance.toFixed(3)}) for ${key}`
            );
            return true;
        }

        return false;
    }

    private computeEffectiveAlpha(
        key: string,
        event: TaskExecutionEvent,
        currentAlpha: number
    ): number {
        const aplDropping = isNaN(event.aplDelta)
            ? !event.success   // Fallback: failure = APL drop
            : event.aplDelta < 0;

        if (aplDropping) {
            const drops = (this.aplDropCounter.get(key) ?? 0) + 1;
            this.aplDropCounter.set(key, drops);

            if (drops >= this.config.alphDecayDropCount) {
                const decayed = currentAlpha * this.config.alphaDecayFactor;
                console.log(
                    `[ReinforcementEngine] Alpha decayed for ${key}: ${currentAlpha.toFixed(4)} → ${decayed.toFixed(4)} ` +
                    `(${drops} consecutive drops)`
                );
                this.aplDropCounter.set(key, 0); // Reset counter after decay
                return Math.max(0.001, decayed);  // Never go to 0
            }
        } else {
            // Reset drop counter on improvement
            this.aplDropCounter.set(key, 0);
        }

        return currentAlpha;
    }

    /** Cap delta to maxDeltaFraction * range */
    private capDelta(delta: number, range: number): number {
        const maxDelta = this.config.maxDeltaFraction * range;
        return Math.max(-maxDelta, Math.min(maxDelta, delta));
    }

    // ============================================================
    // Audit Log
    // ============================================================

    private async logAudit(
        event: TaskExecutionEvent,
        reward: RewardVector,
        before: AdaptiveParams,
        after: AdaptiveParams,
        alpha: number,
        frozen: boolean,
        freezeReason?: string
    ): Promise<void> {
        await this.supabase.from('adaptive_audit_log').insert({
            company_id: event.companyId,
            agent_id: event.agentId,
            task_id: event.taskId,
            task_type: event.taskType,
            reward_vector: reward as unknown as Record<string, unknown>,
            params_before: before as unknown as Record<string, unknown>,
            params_after: after as unknown as Record<string, unknown>,
            alpha_used: alpha,
            frozen,
            freeze_reason: freezeReason ?? null,
        });
    }
}
