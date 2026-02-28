/**
 * SkillRegistry — SKILL.md discovery, installation, and management.
 *
 * Skills live in workspace/skills/:
 *   built-in/   — ship with the agent, always available
 *   installed/  — user-installed from URL or local path
 *   disabled/   — moved here to disable without deleting
 *   skills.json — registry manifest
 *
 * Compatible with agent-zero, Claude Code, and Cursor SKILL.md format.
 */

import { readFile, writeFile, mkdir, readdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, basename } from 'node:path';

// ============================================================
// Types
// ============================================================

export interface SkillMeta {
    name: string;
    description: string;
    enabled: boolean;
    tier: 'built-in' | 'installed';
    version: string;
    installedAt: string;    // ISO timestamp
    lastUsedAt?: string;
    usageCount: number;
    /** Cached embedding for relevance matching */
    embedding?: number[];
}

export interface SkillContent {
    meta: SkillMeta;
    markdown: string;       // Full raw SKILL.md content
}

type RegistryFile = Record<string, SkillMeta>;

// ============================================================
// SkillRegistry
// ============================================================

export class SkillRegistry {
    private readonly builtInDir: string;
    private readonly installedDir: string;
    private readonly disabledDir: string;
    private readonly registryPath: string;

    constructor(private readonly skillsRoot: string) {
        this.builtInDir = join(skillsRoot, 'built-in');
        this.installedDir = join(skillsRoot, 'installed');
        this.disabledDir = join(skillsRoot, 'disabled');
        this.registryPath = join(skillsRoot, 'skills.json');
    }

    /**
     * Create the directory structure and initialize skills.json if missing.
     */
    async init(): Promise<void> {
        await mkdir(this.builtInDir, { recursive: true });
        await mkdir(this.installedDir, { recursive: true });
        await mkdir(this.disabledDir, { recursive: true });

        if (!existsSync(this.registryPath)) {
            await writeFile(this.registryPath, JSON.stringify({}, null, 2));
        }

        // Auto-register any built-in skills not yet in the registry
        await this.syncBuiltIns();
    }

    /**
     * List all skills (enabled and disabled).
     */
    async list(): Promise<SkillMeta[]> {
        const registry = await this.loadRegistry();
        return Object.values(registry);
    }

    /**
     * List only enabled skills.
     */
    async listEnabled(): Promise<SkillMeta[]> {
        const all = await this.list();
        return all.filter((s) => s.enabled);
    }

    /**
     * Load the full content (metadata + markdown) of a skill by name.
     * Returns null if the skill doesn't exist or is disabled.
     */
    async load(name: string): Promise<SkillContent | null> {
        const registry = await this.loadRegistry();
        const meta = registry[name];
        if (!meta || !meta.enabled) return null;

        const skillDir = meta.tier === 'built-in' ? this.builtInDir : this.installedDir;
        const skillPath = join(skillDir, name, 'SKILL.md');

        if (!existsSync(skillPath)) return null;

        const markdown = await readFile(skillPath, 'utf-8');
        return { meta, markdown };
    }

    /**
     * Install a skill from a URL (raw GitHub, CDN) or local path.
     * Creates the skill directory, writes SKILL.md, and registers it.
     */
    async install(source: string, name?: string): Promise<SkillMeta> {
        let markdown: string;

        if (source.startsWith('http')) {
            const res = await fetch(source);
            if (!res.ok) throw new Error(`Failed to fetch skill from ${source}: ${res.statusText}`);
            markdown = await res.text();
        } else {
            markdown = await readFile(source, 'utf-8');
        }

        // Extract name from first heading if not provided
        const skillName = name ?? this.extractNameFromMarkdown(markdown) ?? basename(source, '.md');
        const skillDir = join(this.installedDir, skillName);
        const skillPath = join(skillDir, 'SKILL.md');

        await mkdir(skillDir, { recursive: true });
        await writeFile(skillPath, markdown);

        const meta: SkillMeta = {
            name: skillName,
            description: this.extractDescriptionFromMarkdown(markdown),
            enabled: true,
            tier: 'installed',
            version: '1.0.0',
            installedAt: new Date().toISOString(),
            usageCount: 0,
        };

        await this.updateRegistryEntry(skillName, meta);
        console.log(`[SkillRegistry] Installed skill: ${skillName}`);
        return meta;
    }

    /**
     * Enable a previously disabled skill.
     */
    async enable(name: string): Promise<void> {
        const registry = await this.loadRegistry();
        if (!registry[name]) throw new Error(`Skill not found: ${name}`);

        // If in disabled dir, move back
        const disabledPath = join(this.disabledDir, name);
        const targetDir = registry[name].tier === 'built-in' ? this.builtInDir : this.installedDir;
        const activePath = join(targetDir, name);

        if (existsSync(disabledPath)) {
            await rename(disabledPath, activePath);
        }

        await this.updateRegistryEntry(name, { ...registry[name], enabled: true });
    }

    /**
     * Disable a skill. Moves its directory to disabled/ without deleting.
     */
    async disable(name: string): Promise<void> {
        const registry = await this.loadRegistry();
        if (!registry[name]) throw new Error(`Skill not found: ${name}`);

        const sourceDir = registry[name].tier === 'built-in' ? this.builtInDir : this.installedDir;
        const sourcePath = join(sourceDir, name);
        const disabledPath = join(this.disabledDir, name);

        if (existsSync(sourcePath)) {
            await rename(sourcePath, disabledPath);
        }

        await this.updateRegistryEntry(name, { ...registry[name], enabled: false });
    }

    /**
     * Record a skill usage. Increments usageCount and updates lastUsedAt.
     */
    async recordUsage(names: string[]): Promise<void> {
        const registry = await this.loadRegistry();
        for (const name of names) {
            if (registry[name]) {
                registry[name].usageCount += 1;
                registry[name].lastUsedAt = new Date().toISOString();
            }
        }
        await writeFile(this.registryPath, JSON.stringify(registry, null, 2));
    }

    /**
     * Update the embedding vector for a skill (set after install for similarity search).
     */
    async setEmbedding(name: string, embedding: number[]): Promise<void> {
        const registry = await this.loadRegistry();
        if (registry[name]) {
            registry[name].embedding = embedding;
            await writeFile(this.registryPath, JSON.stringify(registry, null, 2));
        }
    }

    // ============================================================
    // Private helpers
    // ============================================================

    private async loadRegistry(): Promise<RegistryFile> {
        try {
            const contents = await readFile(this.registryPath, 'utf-8');
            return JSON.parse(contents) as RegistryFile;
        } catch {
            return {};
        }
    }

    private async updateRegistryEntry(name: string, meta: SkillMeta): Promise<void> {
        const registry = await this.loadRegistry();
        registry[name] = meta;
        await writeFile(this.registryPath, JSON.stringify(registry, null, 2));
    }

    /**
     * Scan built-in skills directory and register any not yet in skills.json.
     */
    private async syncBuiltIns(): Promise<void> {
        if (!existsSync(this.builtInDir)) return;
        const registry = await this.loadRegistry();
        const entries = await readdir(this.builtInDir, { withFileTypes: true });

        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            if (registry[entry.name]) continue; // already registered

            const skillPath = join(this.builtInDir, entry.name, 'SKILL.md');
            if (!existsSync(skillPath)) continue;

            const markdown = await readFile(skillPath, 'utf-8');
            const meta: SkillMeta = {
                name: entry.name,
                description: this.extractDescriptionFromMarkdown(markdown),
                enabled: true,
                tier: 'built-in',
                version: '1.0.0',
                installedAt: new Date().toISOString(),
                usageCount: 0,
            };

            registry[entry.name] = meta;
        }

        await writeFile(this.registryPath, JSON.stringify(registry, null, 2));
    }

    private extractNameFromMarkdown(markdown: string): string | null {
        const match = /^#\s+(.+)$/m.exec(markdown);
        if (!match || !match[1]) return null;
        return match[1].trim().toLowerCase().replace(/\s+/g, '-');
    }

    private extractDescriptionFromMarkdown(markdown: string): string {
        const lines = markdown.split('\n');
        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed && !trimmed.startsWith('#')) {
                return trimmed.replace(/^>\s*/, '').slice(0, 120);
            }
        }
        return '';
    }
}
