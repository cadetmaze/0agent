/**
 * SkillLoader — Semantic relevance matching and injection.
 *
 * Before every task, the loader searches for skills relevant to the
 * current task description using cosine similarity on stored embeddings.
 * Relevant skills are injected into the system prompt — only when needed,
 * never always. This keeps context clean and token-efficient.
 *
 * If no embeddings are available (no OpenAI key), falls back to keyword
 * matching on skill names and descriptions.
 */

import type { SkillRegistry, SkillContent } from './skill-registry.js';

// ============================================================
// Types
// ============================================================

export interface LoadedSkills {
    skills: SkillContent[];
    /** Formatted block ready to append to the system prompt */
    systemPromptBlock: string;
}

// ============================================================
// Config
// ============================================================

const RELEVANCE_THRESHOLD = 0.60;  // cosine similarity floor
const MAX_SKILLS_PER_TASK = 3;     // cap to avoid context bloat

// ============================================================
// SkillLoader
// ============================================================

export class SkillLoader {
    constructor(
        private readonly registry: SkillRegistry,
        /** Optional: async function that returns an embedding vector for a string */
        private readonly embed?: (text: string) => Promise<number[]>
    ) { }

    /**
     * Load the most relevant skills for a task description.
     * Returns both the skill content array and a pre-formatted prompt block.
     */
    async loadForTask(taskDescription: string): Promise<LoadedSkills> {
        const enabled = await this.registry.listEnabled();
        if (enabled.length === 0) {
            return { skills: [], systemPromptBlock: '' };
        }

        let matched: SkillContent[];

        if (this.embed && enabled.some((s) => s.embedding)) {
            matched = await this.semanticMatch(taskDescription, enabled.map((s) => s.name));
        } else {
            matched = await this.keywordMatch(taskDescription, enabled.map((s) => s.name));
        }

        if (matched.length === 0) {
            return { skills: [], systemPromptBlock: '' };
        }

        // Record usage
        await this.registry.recordUsage(matched.map((s) => s.meta.name));

        const systemPromptBlock = this.formatPromptBlock(matched);
        return { skills: matched, systemPromptBlock };
    }

    // ============================================================
    // Private: matching strategies
    // ============================================================

    private async semanticMatch(
        taskDescription: string,
        skillNames: string[]
    ): Promise<SkillContent[]> {
        if (!this.embed) return [];

        const taskEmbedding = await this.embed(taskDescription);
        const results: Array<{ name: string; score: number }> = [];

        for (const name of skillNames) {
            const skill = await this.registry.load(name);
            if (!skill?.meta.embedding) continue;

            const score = cosineSimilarity(taskEmbedding, skill.meta.embedding);
            if (score >= RELEVANCE_THRESHOLD) {
                results.push({ name, score });
            }
        }

        results.sort((a, b) => b.score - a.score);
        const topNames = results.slice(0, MAX_SKILLS_PER_TASK).map((r) => r.name);

        const loaded: SkillContent[] = [];
        for (const name of topNames) {
            const content = await this.registry.load(name);
            if (content) loaded.push(content);
        }
        return loaded;
    }

    private async keywordMatch(
        taskDescription: string,
        skillNames: string[]
    ): Promise<SkillContent[]> {
        const descLower = taskDescription.toLowerCase();
        const matched: SkillContent[] = [];

        // Simple keyword signal map — expands as skills ship
        const KEYWORD_MAP: Record<string, string[]> = {
            'web-research': ['research', 'search', 'find', 'look up', 'investigate', 'competitor'],
            'code-review': ['review', 'audit', 'check', 'code', 'typescript', 'python', 'bug', 'security'],
            'email-drafting': ['email', 'write', 'draft', 'reply', 'message', 'compose'],
            'data-analysis': ['analyze', 'data', 'csv', 'json', 'spreadsheet', 'metrics', 'report'],
            'task-planning': ['plan', 'break down', 'decompose', 'roadmap', 'schedule', 'organize'],
        };

        const scored: Array<{ name: string; hits: number }> = [];

        for (const name of skillNames) {
            const keywords = KEYWORD_MAP[name] ?? [name.replace(/-/g, ' ')];
            const hits = keywords.filter((kw) => descLower.includes(kw)).length;
            if (hits > 0) scored.push({ name, hits });
        }

        scored.sort((a, b) => b.hits - a.hits);
        const top = scored.slice(0, MAX_SKILLS_PER_TASK);

        for (const { name } of top) {
            const content = await this.registry.load(name);
            if (content) matched.push(content);
        }

        return matched;
    }

    /**
     * Format loaded skills as a system prompt block.
     * Injected after the core system prompt, before the expert judgment block.
     */
    private formatPromptBlock(skills: SkillContent[]): string {
        if (skills.length === 0) return '';

        const blocks = skills.map((s) =>
            `--- SKILL: ${s.meta.name} ---\n${s.markdown.trim()}\n--- END SKILL ---`
        );

        return [
            '## Loaded Skills\n',
            'The following skills are relevant to this task. Follow their guidance precisely.\n',
            ...blocks,
        ].join('\n');
    }
}

// ============================================================
// Utility: cosine similarity
// ============================================================

function cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;

    let dot = 0;
    let magA = 0;
    let magB = 0;

    for (let i = 0; i < a.length; i++) {
        // We verified lengths match above, so index access is safe
        const ai = a[i] as number;
        const bi = b[i] as number;
        dot += ai * bi;
        magA += ai * ai;
        magB += bi * bi;
    }

    const denom = Math.sqrt(magA) * Math.sqrt(magB);
    return denom === 0 ? 0 : dot / denom;
}
