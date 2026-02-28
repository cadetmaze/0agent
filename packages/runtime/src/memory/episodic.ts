/**
 * Episodic Memory — Persistent past session records.
 *
 * Stores summaries and outcomes of past sessions for retrieval
 * when building TaskEnvelopes. Used for context about what has
 * happened before.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ============================================================
// Types
// ============================================================

export interface EpisodicRecord {
    id: string;
    agentId: string;
    sessionId: string;
    summary: string;
    outcome: string;
    createdAt: string;
    sentiment: number;
    relevanceScore?: number;
}

// ============================================================
// EpisodicMemory
// ============================================================

export class EpisodicMemory {
    private supabase: SupabaseClient;

    constructor(supabase: SupabaseClient) {
        this.supabase = supabase;
    }

    /**
     * Record an episodic memory after a session completes.
     */
    async record(
        agentId: string,
        sessionId: string,
        summary: string,
        outcome: string,
        sentiment: number
    ): Promise<void> {
        const { error } = await this.supabase.from('episodic_memory').insert({
            agent_id: agentId,
            session_id: sessionId,
            summary,
            outcome,
            sentiment,
        });

        if (error) {
            throw new Error(`[EpisodicMemory] Failed to record episode: ${error.message}`);
        }
    }

    /**
     * Get relevant episodes for a task spec.
     * In production, this should use semantic similarity search
     * via the Python judgment service. For now, returns recent episodes.
     */
    async getRelevantEpisodes(
        agentId: string,
        _taskSpec: string,
        limit: number = 10
    ): Promise<EpisodicRecord[]> {
        // TODO: Replace with semantic similarity search by calling the
        // Python judgment service's /memory/semantic/search endpoint.
        // Current implementation returns the most recent episodes.

        const { data, error } = await this.supabase
            .from('episodic_memory')
            .select('*')
            .eq('agent_id', agentId)
            .order('created_at', { ascending: false })
            .limit(limit);

        if (error) {
            console.error(`[EpisodicMemory] Failed to fetch episodes: ${error.message}`);
            return [];
        }

        return (data ?? []).map((row) => ({
            id: row.id as string,
            agentId: row.agent_id as string,
            sessionId: row.session_id as string,
            summary: row.summary as string,
            outcome: (row.outcome as string) ?? '',
            createdAt: row.created_at as string,
            sentiment: (row.sentiment as number) ?? 0,
            relevanceScore: 0.5, // TODO: compute actual relevance
        }));
    }

    /**
     * Get all episodes for an agent.
     */
    async getAllEpisodes(agentId: string): Promise<EpisodicRecord[]> {
        const { data, error } = await this.supabase
            .from('episodic_memory')
            .select('*')
            .eq('agent_id', agentId)
            .order('created_at', { ascending: false });

        if (error) {
            throw new Error(`[EpisodicMemory] Failed to fetch episodes: ${error.message}`);
        }

        return (data ?? []).map((row) => ({
            id: row.id as string,
            agentId: row.agent_id as string,
            sessionId: row.session_id as string,
            summary: row.summary as string,
            outcome: (row.outcome as string) ?? '',
            createdAt: row.created_at as string,
            sentiment: (row.sentiment as number) ?? 0,
        }));
    }
}
