/**
 * DecisionLog — Append-only record of every significant decision.
 *
 * This is the institutional memory that survives agent changes,
 * team changes, and time. Every significant decision by any agent
 * or human is recorded with rationale and, eventually, outcome.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ============================================================
// Types
// ============================================================

export type MadeByType = 'agent' | 'human';

export interface DecisionEntry {
    id: string;
    companyId: string;
    agentId: string | null;
    seatId: string | null;
    decisionTitle: string;
    description: string;
    rationale: string;
    madeBy: string;
    madeByType: MadeByType;
    outcome: string | null;
    outcomeRecordedAt: string | null;
    tags: string[];
    createdAt: string;
}

// ============================================================
// DecisionLog
// ============================================================

export class DecisionLog {
    private supabase: SupabaseClient;

    constructor(supabase: SupabaseClient) {
        this.supabase = supabase;
    }

    /**
     * Record a new decision. Append-only — cannot be modified after creation
     * (except for recording the outcome).
     */
    async record(entry: {
        companyId: string;
        agentId?: string;
        seatId?: string;
        decisionTitle: string;
        description: string;
        rationale: string;
        madeBy: string;
        madeByType: MadeByType;
        tags?: string[];
    }): Promise<string> {
        const { data, error } = await this.supabase
            .from('decision_log')
            .insert({
                company_id: entry.companyId,
                agent_id: entry.agentId ?? null,
                seat_id: entry.seatId ?? null,
                decision_title: entry.decisionTitle,
                description: entry.description,
                rationale: entry.rationale,
                made_by: entry.madeBy,
                made_by_type: entry.madeByType,
                tags: entry.tags ?? [],
            })
            .select('id')
            .single();

        if (error || !data) {
            throw new Error(`[DecisionLog] Failed to record decision: ${error?.message}`);
        }

        return data.id as string;
    }

    /**
     * Record the outcome of a previously logged decision.
     * This is the only allowed update on decision_log rows.
     */
    async recordOutcome(decisionId: string, outcome: string): Promise<void> {
        const { error } = await this.supabase
            .from('decision_log')
            .update({
                outcome,
                outcome_recorded_at: new Date().toISOString(),
            })
            .eq('id', decisionId);

        if (error) {
            throw new Error(`[DecisionLog] Failed to record outcome: ${error.message}`);
        }
    }

    /**
     * Get recent decisions for a company.
     */
    async getRecent(companyId: string, limit = 20): Promise<DecisionEntry[]> {
        const { data, error } = await this.supabase
            .from('decision_log')
            .select('*')
            .eq('company_id', companyId)
            .order('created_at', { ascending: false })
            .limit(limit);

        if (error) {
            throw new Error(`[DecisionLog] Failed to fetch decisions: ${error.message}`);
        }

        return (data ?? []).map(this.mapEntry);
    }

    /**
     * Get decisions made by a specific agent.
     */
    async getByAgent(agentId: string, limit = 50): Promise<DecisionEntry[]> {
        const { data, error } = await this.supabase
            .from('decision_log')
            .select('*')
            .eq('agent_id', agentId)
            .order('created_at', { ascending: false })
            .limit(limit);

        if (error) {
            throw new Error(`[DecisionLog] Failed to fetch agent decisions: ${error.message}`);
        }

        return (data ?? []).map(this.mapEntry);
    }

    /**
     * Search decisions by tag.
     */
    async searchByTag(companyId: string, tag: string): Promise<DecisionEntry[]> {
        const { data, error } = await this.supabase
            .from('decision_log')
            .select('*')
            .eq('company_id', companyId)
            .contains('tags', [tag])
            .order('created_at', { ascending: false });

        if (error) {
            throw new Error(`[DecisionLog] Failed to search by tag: ${error.message}`);
        }

        return (data ?? []).map(this.mapEntry);
    }

    // ============================================================
    // Helpers
    // ============================================================

    private mapEntry(row: Record<string, unknown>): DecisionEntry {
        return {
            id: row.id as string,
            companyId: row.company_id as string,
            agentId: (row.agent_id as string) ?? null,
            seatId: (row.seat_id as string) ?? null,
            decisionTitle: row.decision_title as string,
            description: (row.description as string) ?? '',
            rationale: (row.rationale as string) ?? '',
            madeBy: row.made_by as string,
            madeByType: row.made_by_type as MadeByType,
            outcome: (row.outcome as string) ?? null,
            outcomeRecordedAt: (row.outcome_recorded_at as string) ?? null,
            tags: (row.tags as string[]) ?? [],
            createdAt: row.created_at as string,
        };
    }
}
