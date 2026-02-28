/**
 * Working Memory — Session-scoped, ephemeral context.
 *
 * Stores the current context for an active task. Expires when the
 * task completes or the session ends. Backed by the working_memory table.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ============================================================
// WorkingMemory
// ============================================================

export class WorkingMemory {
    private supabase: SupabaseClient;

    constructor(supabase: SupabaseClient) {
        this.supabase = supabase;
    }

    /**
     * Save working context for a task.
     * Overwrites any existing context for this agent+task pair.
     */
    async save(
        agentId: string,
        taskId: string,
        context: Record<string, unknown>
    ): Promise<void> {
        // Delete existing context for this task
        await this.supabase
            .from('working_memory')
            .delete()
            .eq('agent_id', agentId)
            .eq('task_id', taskId);

        // Insert new context
        const { error } = await this.supabase.from('working_memory').insert({
            agent_id: agentId,
            task_id: taskId,
            context_json: context,
            expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // 24h expiry
        });

        if (error) {
            throw new Error(`[WorkingMemory] Failed to save context: ${error.message}`);
        }
    }

    /**
     * Load working context for a task.
     * Returns null if no context exists or it has expired.
     */
    async load(
        agentId: string,
        taskId: string
    ): Promise<Record<string, unknown> | null> {
        const { data, error } = await this.supabase
            .from('working_memory')
            .select('context_json, expires_at')
            .eq('agent_id', agentId)
            .eq('task_id', taskId)
            .single();

        if (error || !data) {
            return null;
        }

        // Check expiry
        const expiresAt = data.expires_at as string | null;
        if (expiresAt && new Date(expiresAt) < new Date()) {
            // Expired — clean up
            await this.clear(agentId, taskId);
            return null;
        }

        return data.context_json as Record<string, unknown>;
    }

    /**
     * Clear working context for a task.
     */
    async clear(agentId: string, taskId: string): Promise<void> {
        const { error } = await this.supabase
            .from('working_memory')
            .delete()
            .eq('agent_id', agentId)
            .eq('task_id', taskId);

        if (error) {
            console.error(`[WorkingMemory] Failed to clear context: ${error.message}`);
        }
    }

    /**
     * Clear all working memory for an agent (e.g., on restart).
     */
    async clearAll(agentId: string): Promise<void> {
        const { error } = await this.supabase
            .from('working_memory')
            .delete()
            .eq('agent_id', agentId);

        if (error) {
            console.error(`[WorkingMemory] Failed to clear all context: ${error.message}`);
        }
    }
}
