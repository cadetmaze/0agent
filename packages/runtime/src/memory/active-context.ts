/**
 * ActiveContext — Company-scoped persistent context.
 *
 * Unlike working memory (task-scoped, ephemeral), active context
 * persists across all sessions and agent swaps. It stores:
 * - Current priorities
 * - In-flight tasks
 * - Open questions
 * - Active experiments
 *
 * Hydrated on every agent boot. Updated after every task completion.
 * When a seat changes holder, the new agent reads the same active context.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ============================================================
// Types
// ============================================================

export interface ActiveContext {
    priorities: string[];
    inFlightTasks: Array<{
        taskId: string;
        description: string;
        status: string;
        assignedTo: string;
    }>;
    openQuestions: Array<{
        question: string;
        raisedBy: string;
        raisedAt: string;
        priority: number;
    }>;
    activeExperiments: Array<{
        name: string;
        hypothesis: string;
        startedAt: string;
        status: string;
        results?: string;
    }>;
}

// ============================================================
// ActiveContextStore
// ============================================================

export class ActiveContextStore {
    private supabase: SupabaseClient;
    private cache: Map<string, ActiveContext> = new Map();

    constructor(supabase: SupabaseClient) {
        this.supabase = supabase;
    }

    /**
     * Load active context for a company.
     * Called on agent boot (Step 3).
     */
    async load(companyId: string): Promise<ActiveContext> {
        const cached = this.cache.get(companyId);
        if (cached) return cached;

        const { data, error } = await this.supabase
            .from('active_context')
            .select('*')
            .eq('company_id', companyId)
            .single();

        if (error || !data) {
            // No active context yet — return empty
            const empty: ActiveContext = {
                priorities: [],
                inFlightTasks: [],
                openQuestions: [],
                activeExperiments: [],
            };
            this.cache.set(companyId, empty);
            return empty;
        }

        const ctx: ActiveContext = {
            priorities: (data.priorities as string[]) ?? [],
            inFlightTasks: (data.in_flight_tasks as ActiveContext['inFlightTasks']) ?? [],
            openQuestions: (data.open_questions as ActiveContext['openQuestions']) ?? [],
            activeExperiments: (data.active_experiments as ActiveContext['activeExperiments']) ?? [],
        };

        this.cache.set(companyId, ctx);
        return ctx;
    }

    /**
     * Update active context after a task completes.
     * Merges changes rather than replacing.
     */
    async update(
        companyId: string,
        agentId: string,
        updates: Partial<ActiveContext>
    ): Promise<void> {
        const current = await this.load(companyId);

        const merged: ActiveContext = {
            priorities: updates.priorities ?? current.priorities,
            inFlightTasks: updates.inFlightTasks ?? current.inFlightTasks,
            openQuestions: updates.openQuestions ?? current.openQuestions,
            activeExperiments: updates.activeExperiments ?? current.activeExperiments,
        };

        const { error } = await this.supabase
            .from('active_context')
            .upsert(
                {
                    company_id: companyId,
                    priorities: merged.priorities,
                    in_flight_tasks: merged.inFlightTasks,
                    open_questions: merged.openQuestions,
                    active_experiments: merged.activeExperiments,
                    updated_at: new Date().toISOString(),
                    updated_by_agent: agentId,
                },
                { onConflict: 'company_id' }
            );

        if (error) {
            throw new Error(`[ActiveContext] Failed to update: ${error.message}`);
        }

        this.cache.set(companyId, merged);
    }

    /**
     * Add a task to in-flight list.
     */
    async addInFlightTask(
        companyId: string,
        agentId: string,
        task: { taskId: string; description: string; status: string; assignedTo: string }
    ): Promise<void> {
        const current = await this.load(companyId);
        const updated = [...current.inFlightTasks, task];
        await this.update(companyId, agentId, { inFlightTasks: updated });
    }

    /**
     * Remove a completed task from in-flight list.
     */
    async completeInFlightTask(
        companyId: string,
        agentId: string,
        taskId: string
    ): Promise<void> {
        const current = await this.load(companyId);
        const updated = current.inFlightTasks.filter((t) => t.taskId !== taskId);
        await this.update(companyId, agentId, { inFlightTasks: updated });
    }

    /**
     * Snapshot for envelope construction.
     * Returns the current active context in a shape ready for OrgContext.
     */
    snapshot(companyId: string): ActiveContext | undefined {
        return this.cache.get(companyId);
    }

    /**
     * Clear cache (useful for tests or after seat changes).
     */
    clearCache(): void {
        this.cache.clear();
    }
}
