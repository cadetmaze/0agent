/**
 * TrustRegistry — APL-based trust scores for agents.
 *
 * Trust is earned by verified outcomes, not assumed from shared credentials.
 * Scores are computed from APL measurements and stored in the trust_registry table.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ============================================================
// Types
// ============================================================

export interface TrustScore {
    agentId: string;
    aplScore: number;
    transactionCount: number;
    lastUpdated: string;
}

export interface TrustThresholds {
    /** Minimum APL score to be considered trustworthy */
    minimumApl: number;
    /** Minimum transactions before trust is meaningful */
    minimumTransactions: number;
    /** APL score above which the agent is highly trusted */
    highTrustThreshold: number;
}

const DEFAULT_THRESHOLDS: TrustThresholds = {
    minimumApl: 0.1,
    minimumTransactions: 5,
    highTrustThreshold: 0.8,
};

// ============================================================
// TrustRegistry Class
// ============================================================

export class TrustRegistry {
    private supabase: SupabaseClient;
    private thresholds: TrustThresholds;
    private cache: Map<string, TrustScore> = new Map();

    constructor(supabase: SupabaseClient, thresholds?: TrustThresholds) {
        this.supabase = supabase;
        this.thresholds = thresholds ?? DEFAULT_THRESHOLDS;
    }

    /**
     * Get the trust score for an agent.
     * Returns from cache if available, otherwise queries the database.
     */
    async getTrustScore(agentId: string): Promise<TrustScore> {
        // Check cache first
        const cached = this.cache.get(agentId);
        if (cached) {
            return cached;
        }

        const { data, error } = await this.supabase
            .from('trust_registry')
            .select('*')
            .eq('agent_id', agentId)
            .single();

        if (error || !data) {
            // No trust record — return default untrusted score
            return {
                agentId,
                aplScore: 0,
                transactionCount: 0,
                lastUpdated: new Date().toISOString(),
            };
        }

        const score: TrustScore = {
            agentId: data.agent_id as string,
            aplScore: data.apl_score as number,
            transactionCount: data.transaction_count as number,
            lastUpdated: data.last_updated as string,
        };

        this.cache.set(agentId, score);
        return score;
    }

    /**
     * Update the trust score for an agent.
     * Called by the APL engine after computing new measurements.
     */
    async updateTrustScore(
        agentId: string,
        aplScore: number,
        transactionCount: number
    ): Promise<void> {
        const now = new Date().toISOString();

        const { error } = await this.supabase
            .from('trust_registry')
            .upsert(
                {
                    agent_id: agentId,
                    apl_score: aplScore,
                    transaction_count: transactionCount,
                    last_updated: now,
                },
                { onConflict: 'agent_id' }
            );

        if (error) {
            throw new Error(
                `[TrustRegistry] Failed to update trust score: ${error.message}`
            );
        }

        // Update cache
        this.cache.set(agentId, {
            agentId,
            aplScore,
            transactionCount,
            lastUpdated: now,
        });
    }

    /**
     * Check if an agent is trusted enough for a given operation.
     */
    async isTrusted(agentId: string): Promise<boolean> {
        const score = await this.getTrustScore(agentId);
        return (
            score.aplScore >= this.thresholds.minimumApl &&
            score.transactionCount >= this.thresholds.minimumTransactions
        );
    }

    /**
     * Check if an agent has high trust (can receive more autonomous tasks).
     */
    async isHighTrust(agentId: string): Promise<boolean> {
        const score = await this.getTrustScore(agentId);
        return score.aplScore >= this.thresholds.highTrustThreshold;
    }

    /**
     * Clear the in-memory cache. Useful after bulk score updates.
     */
    clearCache(): void {
        this.cache.clear();
    }
}
