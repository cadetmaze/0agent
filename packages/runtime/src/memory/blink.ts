/**
 * BlinkEngine — Periodic cognitive reset for agents.
 *
 * Borrowed from PicoHive's HIVE Memory Architecture: agents shouldn't
 * accumulate raw context forever. The Blink Cycle compresses working
 * context into three focused questions, archives noise to the KG,
 * and gives the agent a fresh, lean focus block.
 *
 * Triggers:
 *   - Token count exceeds 80% of 30k ceiling (24k tokens)
 *   - Every N tasks completed (default: 5)
 *   - Every 30 minutes of elapsed session time
 *   - Circuit breaker soft trip (cognitive load indicator)
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { KGStore, type KGNode } from './kg-store.js';

// ============================================================
// Types
// ============================================================

export type BlinkTrigger =
    | 'task_count'
    | 'token_threshold'
    | 'time_elapsed'
    | 'cognitive_load'
    | 'circuit_breaker';

export type CognitiveLoad = 'low' | 'medium' | 'high';

export interface BlinkState {
    /** What actually matters for the current work. 1-2 sentences max. */
    whatMatters: string;
    /** Key decisions made that must be preserved. Max 5. */
    whatDecided: string[];
    /** The current action/focus. One sentence. */
    whatDoing: string;
    /** Context items to keep in working memory. */
    commitments: string[];
    /** Context items that were released/archived. */
    noiseReleased: string[];
    /** Assessed cognitive load level. */
    cognitiveLoad: CognitiveLoad;
    /** 0-1 drift risk score. */
    driftRisk: number;
    /** When this blink happened. */
    blinkAt: string;
    /** What triggered this blink. */
    trigger: BlinkTrigger;
}

export interface BlinkConfig {
    /** Token count that triggers a blink. Default: 24,000 (80% of 30k) */
    tokenThreshold: number;
    /** Task count interval between blinks. Default: 5 */
    taskInterval: number;
    /** Time interval between blinks in ms. Default: 30 min */
    timeIntervalMs: number;
}

const DEFAULT_BLINK_CONFIG: BlinkConfig = {
    tokenThreshold: 24_000,
    taskInterval: 5,
    timeIntervalMs: 30 * 60 * 1000,
};

// ============================================================
// BlinkEngine
// ============================================================

export class BlinkEngine {
    private config: BlinkConfig;
    /** Task completion counters per agent. */
    private taskCounters: Map<string, number> = new Map();
    /** Last blink time per agent. */
    private lastBlinkAt: Map<string, number> = new Map();

    constructor(
        private supabase: SupabaseClient,
        private kg: KGStore,
        config?: Partial<BlinkConfig>
    ) {
        this.config = { ...DEFAULT_BLINK_CONFIG, ...config };
    }

    // ============================================================
    // Public API
    // ============================================================

    /**
     * Record task completion for an agent. Checks if blink should fire.
     * Returns true if a blink cycle was triggered.
     */
    async onTaskCompleted(
        agentId: string,
        companyId: string,
        taskId: string,
        currentTokenCount: number
    ): Promise<BlinkState | null> {
        const key = `${agentId}:${companyId}`;

        // Increment task counter
        const count = (this.taskCounters.get(key) ?? 0) + 1;
        this.taskCounters.set(key, count);

        const shouldBlink = await this.shouldBlink(agentId, companyId, currentTokenCount, count);
        if (!shouldBlink.fire) return null;

        return this.blink(agentId, companyId, taskId, shouldBlink.trigger, currentTokenCount);
    }

    /**
     * Force a blink cycle. Called by the circuit breaker on cognitive load.
     */
    async blink(
        agentId: string,
        companyId: string,
        taskId: string | undefined,
        trigger: BlinkTrigger,
        currentTokenCount: number
    ): Promise<BlinkState> {
        const key = `${agentId}:${companyId}`;
        console.log(`[BlinkEngine] Blink triggered for agent ${agentId} (${trigger})`);

        // 1. Fetch recent KG nodes to assess state
        const recentNodes = await this.kg.search('recent activity decisions', companyId, {
            limit: 10,
            types: ['episode', 'decision', 'insight'],
            scope: ['agent'],
        });

        // 2. Build blink state from recent nodes
        const blinkState = this.buildBlinkState(recentNodes, trigger, currentTokenCount);

        // 3. Archive low-importance nodes from this agent's working context
        const nodesArchived = await this.archiveWorkingNoise(agentId, companyId, recentNodes, blinkState);

        // 4. Write the blink state as a KG node (compact, high-importance)
        await this.kg.writeNode({
            companyId,
            agentId,
            nodeType: 'blink',
            scope: 'agent',
            title: `Blink: ${blinkState.whatDoing}`,
            content: this.serializeBlinkState(blinkState),
            emergedFromTaskId: taskId,
            emergedFromSession: key,
            emergedContext: { trigger, tokensBefore: currentTokenCount },
            importance: 0.9,
            tags: ['blink', trigger],
        });

        // 5. Persist blink cycle to DB
        await this.supabase.from('blink_cycles').insert({
            company_id: companyId,
            agent_id: agentId,
            task_id: taskId ?? null,
            trigger,
            what_matters: blinkState.whatMatters,
            what_decided: blinkState.whatDecided,
            what_doing: blinkState.whatDoing,
            commitments: blinkState.commitments,
            noise_released: blinkState.noiseReleased,
            cognitive_load: blinkState.cognitiveLoad,
            drift_risk: blinkState.driftRisk,
            tokens_before: currentTokenCount,
            tokens_after: Math.floor(currentTokenCount * 0.3), // Estimate after compression
            nodes_archived: nodesArchived,
        });

        // 6. Reset counters
        this.taskCounters.set(key, 0);
        this.lastBlinkAt.set(key, Date.now());

        console.log(
            `[BlinkEngine] Blink complete: ${nodesArchived} nodes archived, ` +
            `cognitive load: ${blinkState.cognitiveLoad}, drift risk: ${blinkState.driftRisk.toFixed(2)}`
        );

        return blinkState;
    }

    /**
     * Get the latest blink state for an agent.
     * Returns null if no blink has occurred yet.
     */
    async getLatestState(agentId: string, companyId: string): Promise<BlinkState | null> {
        const { data } = await this.supabase
            .from('blink_cycles')
            .select('*')
            .eq('agent_id', agentId)
            .eq('company_id', companyId)
            .order('created_at', { ascending: false })
            .limit(1)
            .single();

        if (!data) return null;

        return {
            whatMatters: data.what_matters as string,
            whatDecided: data.what_decided as string[],
            whatDoing: data.what_doing as string,
            commitments: data.commitments as string[],
            noiseReleased: data.noise_released as string[],
            cognitiveLoad: data.cognitive_load as CognitiveLoad,
            driftRisk: data.drift_risk as number,
            blinkAt: data.created_at as string,
            trigger: data.trigger as BlinkTrigger,
        };
    }

    /**
     * Serialize a BlinkState into a compact KG node content string.
     * This is what gets injected into context instead of a long system prompt.
     */
    serializeBlinkState(state: BlinkState): string {
        return [
            `## Blink State (${state.trigger} — ${state.blinkAt})`,
            '',
            `**What Matters**: ${state.whatMatters}`,
            '',
            `**Current Focus**: ${state.whatDoing}`,
            '',
            state.whatDecided.length > 0
                ? `**Decisions Made**:\n${state.whatDecided.map((d) => `- ${d}`).join('\n')}`
                : '',
            '',
            state.commitments.length > 0
                ? `**Preserved**:\n${state.commitments.map((c) => `- ${c}`).join('\n')}`
                : '',
            '',
            `Cognitive Load: ${state.cognitiveLoad} | Drift Risk: ${(state.driftRisk * 100).toFixed(0)}%`,
        ].filter(Boolean).join('\n');
    }

    // ============================================================
    // Private
    // ============================================================

    private async shouldBlink(
        agentId: string,
        companyId: string,
        tokenCount: number,
        taskCount: number
    ): Promise<{ fire: boolean; trigger: BlinkTrigger }> {
        const key = `${agentId}:${companyId}`;

        if (tokenCount >= this.config.tokenThreshold) {
            return { fire: true, trigger: 'token_threshold' };
        }

        if (taskCount >= this.config.taskInterval) {
            return { fire: true, trigger: 'task_count' };
        }

        const lastBlink = this.lastBlinkAt.get(key);
        if (lastBlink && Date.now() - lastBlink >= this.config.timeIntervalMs) {
            return { fire: true, trigger: 'time_elapsed' };
        }

        return { fire: false, trigger: 'task_count' };
    }

    private buildBlinkState(
        recentNodes: KGNode[],
        trigger: BlinkTrigger,
        currentTokenCount: number
    ): BlinkState {
        // Extract decisions and insights from recent nodes
        const decisions = recentNodes
            .filter((n) => n.nodeType === 'decision')
            .slice(0, 5)
            .map((n) => n.title);

        const currentFocus = recentNodes[0]?.title ?? 'Processing tasks';

        // Assess cognitive load based on escalation patterns in node tags
        const escalatedCount = recentNodes.filter((n) => n.tags.includes('escalated')).length;
        const cognitiveLoad: CognitiveLoad =
            escalatedCount >= 3 ? 'high' :
                escalatedCount >= 1 ? 'medium' : 'low';

        // Drift risk: high token count + escalations = likely drifting
        const driftRisk = Math.min(
            1.0,
            (currentTokenCount / this.config.tokenThreshold) * 0.5 +
            (escalatedCount / Math.max(recentNodes.length, 1)) * 0.5
        );

        // What to keep: high-importance nodes summaries
        const commitments = recentNodes
            .filter((n) => n.importance >= 0.7)
            .slice(0, 5)
            .map((n) => n.title);

        // What to release: low-importance episode nodes
        const noiseReleased = recentNodes
            .filter((n) => n.importance < 0.4 && n.nodeType === 'episode')
            .map((n) => n.title);

        return {
            whatMatters: recentNodes[0]
                ? `Working on ${recentNodes[0].nodeType}: "${recentNodes[0].title}"`
                : 'Processing incoming tasks',
            whatDecided: decisions,
            whatDoing: currentFocus,
            commitments,
            noiseReleased,
            cognitiveLoad,
            driftRisk: Math.round(driftRisk * 100) / 100,
            blinkAt: new Date().toISOString(),
            trigger,
        };
    }

    private async archiveWorkingNoise(
        agentId: string,
        companyId: string,
        recentNodes: KGNode[],
        blinkState: BlinkState
    ): Promise<number> {
        // Archive nodes that are in the "noise released" list
        const noiseSet = new Set(blinkState.noiseReleased);
        const toArchive = recentNodes.filter((n) => noiseSet.has(n.title) && !n.isContinuation);

        for (const node of toArchive) {
            await this.kg.archive(node.id);
        }

        // Also archive stale nodes generally
        const staleCount = await this.kg.archiveStale(companyId);

        return toArchive.length + staleCount;
    }
}
