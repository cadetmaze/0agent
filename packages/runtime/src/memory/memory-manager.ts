/**
 * MemoryManager — Coordinates all memory tiers.
 *
 * Five tiers:
 * 1. Working Memory — session-scoped, ephemeral
 * 2. Episodic Memory — persistent past sessions
 * 3. Org Knowledge Graph — organizational context
 * 4. Decision Log — append-only institutional memory
 * 5. Active Context — company-scoped persistent context
 *
 * The manager provides a unified interface for the agent to interact
 * with all memory tiers and assembles the org context portion of TaskEnvelopes.
 */

import type { OrgContext, EpisodicEvent, OptimizationMode } from '../core/envelope.js';
import { WorkingMemory } from './working.js';
import { EpisodicMemory } from './episodic.js';
import { OrgGraph, type CompanyContext } from './org-graph.js';
import { DecisionLog } from './decision-log.js';
import { ActiveContextStore } from './active-context.js';
import { KGStore } from './kg-store.js';
import { BlinkEngine } from './blink.js';
import type { SupabaseClient } from '@supabase/supabase-js';

// ============================================================
// Context Window Caps — prevent envelope bloat
// ============================================================

export interface ContextWindowCaps {
    /** Max number of active decisions in OrgContext. Default: 15 */
    maxDecisions: number;
    /** Max episodic history entries. Default: 10 */
    maxHistory: number;
    /** Max open questions in active context. Default: 20 */
    maxOpenQuestions: number;
    /** Max active experiments in active context. Default: 10 */
    maxExperiments: number;
    /** Max key people entries. Default: 15 */
    maxKeyPeople: number;
}

const DEFAULT_CAPS: ContextWindowCaps = {
    maxDecisions: 15,
    maxHistory: 10,
    maxOpenQuestions: 20,
    maxExperiments: 10,
    maxKeyPeople: 15,
};

// ============================================================
// MemoryManager
// ============================================================

export class MemoryManager {
    public working: WorkingMemory;
    public episodic: EpisodicMemory;
    public orgGraph: OrgGraph;
    public decisionLog: DecisionLog;
    public activeContext: ActiveContextStore;
    public kg: KGStore;
    public blink: BlinkEngine;
    private caps: ContextWindowCaps;

    constructor(supabase: SupabaseClient, caps?: Partial<ContextWindowCaps>) {
        this.working = new WorkingMemory(supabase);
        this.episodic = new EpisodicMemory(supabase);
        this.orgGraph = new OrgGraph(supabase);
        this.decisionLog = new DecisionLog(supabase);
        this.activeContext = new ActiveContextStore(supabase);
        this.kg = new KGStore(supabase);
        this.blink = new BlinkEngine(supabase, this.kg);
        this.caps = { ...DEFAULT_CAPS, ...caps };
    }

    /**
     * Build the OrgContext portion of a TaskEnvelope.
     *
     * Uses Knowledge Graph retrieval instead of a flat context dump.
     * The agent receives:
     *   1. The latest BlinkState (compact focus block, ~200 tokens)
     *   2. Up to 8 semantically relevant KG nodes for this task spec
     *   3. Recent 5 decisions (capped)
     *   4. Active context (priorities + open questions, capped)
     *
     * Total context is kept lean (≈ 8k tokens) — no long system prompts.
     */
    async buildOrgContext(
        agentId: string,
        companyId: string,
        taskSpec: string
    ): Promise<OrgContext> {
        // --- Tier 1: Always-on org data (goal, constraints) ---
        let orgData = this.emptyContext();
        try {
            orgData = await this.orgGraph.getCompanyContext(companyId);
        } catch (err) {
            console.warn(`[MemoryManager] OrgGraph fetch failed (local mode): ${(err as Error).message}`);
        }

        // --- Tier 2: Blink State (compact focus block) ---
        let blinkState = null;
        try {
            blinkState = await this.blink.getLatestState(agentId, companyId);
        } catch (err) {
            // Non-fatal
        }

        // --- Tier 3: KG semantic retrieval for task-relevant nodes ---
        let kgNodes: any[] = [];
        try {
            kgNodes = await this.kg.search(taskSpec, companyId, {
                limit: 8,
                types: ['decision', 'insight', 'procedure', 'episode'],
                scope: ['agent', 'org'],
                minImportance: 0.3,
            });
        } catch (err) {
            // Non-fatal, return empty kgNodes
        }

        // --- Tier 4: Recent decisions (capped) ---
        let recentDecisions: any[] = [];
        try {
            recentDecisions = await this.decisionLog.getRecent(companyId, 5);
        } catch (err) {
            // Non-fatal
        }

        // --- Tier 5: Active context ---
        let activeCtx = { priorities: [], openQuestions: [], activeExperiments: [], inFlightTasks: [] };
        try {
            activeCtx = await this.activeContext.load(companyId) as any;
        } catch (err) {
            // Non-fatal
        }

        // Convert KG nodes to Decision format for OrgContext
        const kgDecisions = kgNodes.map((node) => ({
            id: node.id,
            title: node.title,
            description: node.content.slice(0, 300), // Excerpt only — no full dump
            status: 'decided' as const,
            stakeholders: [],
            madeBy: node.agentId,
            madeByType: 'agent' as const,
            tags: node.tags,
        }));

        const decisionLogDecisions = recentDecisions.map((d) => ({
            id: d.id,
            title: d.decisionTitle,
            description: d.description,
            status: 'decided' as const,
            stakeholders: [],
            madeBy: d.madeBy,
            madeByType: d.madeByType,
            outcome: d.outcome ?? undefined,
            tags: d.tags,
        }));

        // --- Apply context window caps ---
        const allDecisions = [...kgDecisions, ...decisionLogDecisions];
        const cappedDecisions = allDecisions.slice(0, this.caps.maxDecisions);
        const cappedKeyPeople = orgData.keyPeople.slice(0, this.caps.maxKeyPeople);
        const cappedQuestions = activeCtx.openQuestions.slice(0, this.caps.maxOpenQuestions);
        const cappedExperiments = activeCtx.activeExperiments.slice(0, this.caps.maxExperiments);

        if (allDecisions.length > this.caps.maxDecisions) {
            console.log(
                `[MemoryManager] Context cap: decisions ${allDecisions.length} → ${this.caps.maxDecisions}`
            );
        }

        // Inject blink state as a structured context note
        const blinkNote = blinkState
            ? `\n---\n${this.blink.serializeBlinkState(blinkState)}\n---`
            : '';

        return {
            goal: orgData.goal + blinkNote,
            activeDecisions: cappedDecisions,
            keyPeople: cappedKeyPeople,
            budgetRemaining: orgData.budgetRemaining,
            constraints: orgData.constraints,
            history: [],       // Episodic history now in KG — retrieved on demand, not bulk-loaded
            activeContext: {
                priorities: activeCtx.priorities,
                openQuestions: cappedQuestions,
                activeExperiments: cappedExperiments,
            },
        };
    }

    /**
     * Save the current working memory context for a task.
     */
    async saveWorkingContext(
        agentId: string,
        taskId: string,
        context: Record<string, unknown>
    ): Promise<void> {
        await this.working.save(agentId, taskId, context);
    }

    /**
     * Load working memory context for a task.
     */
    async loadWorkingContext(
        agentId: string,
        taskId: string
    ): Promise<Record<string, unknown> | null> {
        return this.working.load(agentId, taskId);
    }

    /**
     * Record an episodic memory after a session completes.
     */
    async recordEpisode(
        agentId: string,
        sessionId: string,
        summary: string,
        outcome: string,
        sentiment: number
    ): Promise<void> {
        await this.episodic.record(agentId, sessionId, summary, outcome, sentiment);
    }

    private emptyContext(): CompanyContext {
        return {
            goal: '',
            activeDecisions: [],
            keyPeople: [],
            budgetRemaining: 0,
            constraints: [],
        };
    }
}
