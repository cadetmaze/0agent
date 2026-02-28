/**
 * AdaptivePolicyStore — Org-scoped, versioned, resettable adaptive parameters.
 *
 * Stores per-task-type Q-values for:
 *   - Router provider weights
 *   - Escalation confidence threshold delta
 *   - Budget multiplier per task class
 *   - Retry weighting
 *   - Delegation depth factor
 *
 * Constraints:
 *   - May NOT touch Core Memory, Policy Engine, or expert hard constraints
 *   - Bounded ranges on all parameters to prevent drastic shifts
 *   - Full version history (old rows marked is_active=false)
 *   - Resettable to defaults at any time
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { TaskClassification } from '../router/llm-router.js';

// ============================================================
// Types
// ============================================================

/** Q-value (expected reward) per provider for a given task type. */
export type RouterWeights = Record<string, number>;

export interface AdaptiveParams {
    /** Q-values per provider. Higher = prefer this provider. */
    routerWeights: RouterWeights;

    /** Delta added to base escalation confidence threshold. Range: [-0.2, +0.2] */
    escalationThresholdDelta: number;

    /** Multiplier applied to budget allocation for this task type. Range: [0.5, 2.0] */
    budgetMultiplier: number;

    /** Retry backoff weighting multiplier. Range: [0.5, 2.0] */
    retryWeighting: number;

    /** Depth factor for sub-agent delegation decisions. Range: [0.5, 1.5] */
    delegationDepthFactor: number;

    /** Current learning rate (alpha). Decays when APL drops consistently. */
    alpha: number;

    /** Number of Q-updates applied to this record. */
    updateCount: number;

    /** Whether adaptation is frozen (safety guard). */
    frozen: boolean;
}

/** Default (baseline) parameter values. */
export const DEFAULT_ADAPTIVE_PARAMS: Readonly<AdaptiveParams> = {
    routerWeights: {},
    escalationThresholdDelta: 0.0,
    budgetMultiplier: 1.0,
    retryWeighting: 1.0,
    delegationDepthFactor: 1.0,
    alpha: 0.05,
    updateCount: 0,
    frozen: false,
};

/** Parameter bounds — no update may push outside these ranges. */
export const PARAM_BOUNDS = {
    escalationThresholdDelta: { min: -0.2, max: 0.2 },
    budgetMultiplier: { min: 0.5, max: 2.0 },
    retryWeighting: { min: 0.5, max: 2.0 },
    delegationDepthFactor: { min: 0.5, max: 1.5 },
    routerQValue: { min: -1.0, max: 1.0 },
} as const;

// ============================================================
// AdaptivePolicyStore
// ============================================================

export class AdaptivePolicyStore {
    constructor(private supabase: SupabaseClient) { }

    /**
     * Load adaptive params for an agent+taskType.
     * Returns defaults if no record exists yet.
     */
    async load(
        companyId: string,
        agentId: string,
        taskType: TaskClassification
    ): Promise<AdaptiveParams> {
        const { data, error } = await this.supabase
            .from('adaptive_policy_store')
            .select('params')
            .eq('company_id', companyId)
            .eq('agent_id', agentId)
            .eq('task_type', taskType)
            .eq('is_active', true)
            .single();

        if (error || !data) {
            return { ...DEFAULT_ADAPTIVE_PARAMS };
        }

        return { ...DEFAULT_ADAPTIVE_PARAMS, ...(data.params as Partial<AdaptiveParams>) };
    }

    /**
     * Persist updated params. Deactivates the previous active row,
     * inserts a new versioned row.
     */
    async save(
        companyId: string,
        agentId: string,
        taskType: TaskClassification,
        params: AdaptiveParams
    ): Promise<void> {
        // Get current version
        const { data: current } = await this.supabase
            .from('adaptive_policy_store')
            .select('id, version')
            .eq('company_id', companyId)
            .eq('agent_id', agentId)
            .eq('task_type', taskType)
            .eq('is_active', true)
            .single();

        const newVersion = current ? (current.version as number) + 1 : 1;

        // Deactivate current
        if (current) {
            await this.supabase
                .from('adaptive_policy_store')
                .update({ is_active: false })
                .eq('id', current.id);
        }

        // Insert new version
        await this.supabase.from('adaptive_policy_store').insert({
            company_id: companyId,
            agent_id: agentId,
            task_type: taskType,
            version: newVersion,
            params: params as unknown as Record<string, unknown>,
            is_active: true,
        });
    }

    /**
     * Reset params to defaults. Useful for debugging or hard resets.
     */
    async reset(
        companyId: string,
        agentId: string,
        taskType: TaskClassification
    ): Promise<void> {
        await this.save(companyId, agentId, taskType, {
            ...DEFAULT_ADAPTIVE_PARAMS,
        });

        console.log(
            `[AdaptivePolicyStore] Reset params for agent ${agentId} task_type ${taskType}`
        );
    }

    /**
     * Freeze adaptation — no further Q-updates until unfrozen.
     */
    async freeze(
        companyId: string,
        agentId: string,
        taskType: TaskClassification,
        reason: string
    ): Promise<void> {
        const current = await this.load(companyId, agentId, taskType);
        await this.save(companyId, agentId, taskType, { ...current, frozen: true });
        console.warn(
            `[AdaptivePolicyStore] FROZEN agent ${agentId} task_type ${taskType}: ${reason}`
        );
    }

    /**
     * Clamp a value within its allowed bounds.
     */
    static clamp(param: keyof typeof PARAM_BOUNDS, value: number): number {
        const { min, max } = PARAM_BOUNDS[param];
        return Math.max(min, Math.min(max, value));
    }

    /**
     * Clamp a router Q-value within its allowed bounds.
     */
    static clampQValue(value: number): number {
        return AdaptivePolicyStore.clamp('routerQValue', value);
    }

    /**
     * Get the full version history for an agent + task type.
     */
    async getHistory(
        companyId: string,
        agentId: string,
        taskType: TaskClassification,
        limit: number = 10
    ): Promise<Array<{ version: number; params: AdaptiveParams; createdAt: string }>> {
        const { data } = await this.supabase
            .from('adaptive_policy_store')
            .select('version, params, created_at')
            .eq('company_id', companyId)
            .eq('agent_id', agentId)
            .eq('task_type', taskType)
            .order('version', { ascending: false })
            .limit(limit);

        return (data ?? []).map((row: Record<string, unknown>) => ({
            version: row.version as number,
            params: { ...DEFAULT_ADAPTIVE_PARAMS, ...(row.params as Partial<AdaptiveParams>) },
            createdAt: row.created_at as string,
        }));
    }
}
