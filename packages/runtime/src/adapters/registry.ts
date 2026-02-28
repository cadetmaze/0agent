/**
 * AdapterRegistry — Auto-discovery and validation of capability adapters.
 *
 * Discovers all registered adapters, validates their manifests are complete,
 * and exposes getAdapter(id) for the orchestrator. Logs available adapters at startup.
 */

import type {
    CapabilityAdapter,
    CapabilityManifest,
    HealthStatus,
} from './base.js';

// ============================================================
// Registry
// ============================================================

export class AdapterRegistry {
    private adapters: Map<string, CapabilityAdapter> = new Map();

    /**
     * Register an adapter. Validates the manifest before accepting.
     */
    register(adapter: CapabilityAdapter): void {
        const manifest = adapter.manifest();
        this.validateManifest(manifest);

        if (this.adapters.has(manifest.id)) {
            throw new Error(
                `[AdapterRegistry] Adapter with id "${manifest.id}" is already registered`
            );
        }

        this.adapters.set(manifest.id, adapter);
        console.log(
            `[AdapterRegistry] Registered adapter: ${manifest.name} (${manifest.id}) v${manifest.version}`
        );
    }

    /**
     * Get an adapter by ID. Returns null if not found.
     */
    getAdapter(id: string): CapabilityAdapter | null {
        return this.adapters.get(id) ?? null;
    }

    /**
     * Get all registered adapter IDs.
     */
    getAdapterIds(): string[] {
        return Array.from(this.adapters.keys());
    }

    /**
     * Get all registered adapter manifests.
     */
    getManifests(): CapabilityManifest[] {
        return Array.from(this.adapters.values()).map((a) => a.manifest());
    }

    /**
     * Run health checks on all registered adapters.
     */
    async healthCheckAll(): Promise<HealthStatus[]> {
        const results: HealthStatus[] = [];

        for (const [id, adapter] of this.adapters) {
            try {
                const health = await adapter.health();
                results.push(health);
            } catch (error) {
                const message = error instanceof Error ? error.message : 'Unknown error';
                results.push({
                    healthy: false,
                    adapterId: id,
                    lastChecked: new Date().toISOString(),
                    details: `Health check failed: ${message}`,
                });
            }
        }

        return results;
    }

    /**
     * Log all available adapters at startup.
     */
    logAvailableAdapters(): void {
        const count = this.adapters.size;
        console.log(`[AdapterRegistry] ${count} adapter(s) available:`);

        for (const [id, adapter] of this.adapters) {
            const m = adapter.manifest();
            console.log(
                `  - ${m.name} (${id}) v${m.version} | side-effects: ${m.sideEffects} | credentials: ${m.requiresCredentials.join(', ') || 'none'}`
            );
        }
    }

    /**
     * Initialize all built-in adapters.
     * Imports and registers the stub adapters shipped with the runtime.
     */
    async discoverBuiltinAdapters(): Promise<void> {
        // TODO: Replace with dynamic import scanning of the adapters/ directory.
        // For now, we import known stubs explicitly.
        const { BrowserAdapter } = await import('./browser.js');
        const { GmailAdapter } = await import('./gmail.js');
        const { SlackAdapter } = await import('./slack.js');
        const { CalendarAdapter } = await import('./calendar.js');
        const { SandboxAdapter } = await import('./sandbox.js');
        const { TelegramAdapter } = await import('./telegram.js');

        this.register(new BrowserAdapter());
        this.register(new GmailAdapter());
        this.register(new SlackAdapter());
        this.register(new CalendarAdapter());
        this.register(new SandboxAdapter());
        this.register(new TelegramAdapter());
    }

    // ============================================================
    // Private helpers
    // ============================================================

    /**
     * Validate that a manifest has all required fields.
     */
    private validateManifest(manifest: CapabilityManifest): void {
        const required: (keyof CapabilityManifest)[] = [
            'id',
            'name',
            'description',
            'version',
            'inputSchema',
            'outputSchema',
            'requiresCredentials',
            'sideEffects',
        ];

        for (const field of required) {
            if (manifest[field] === undefined || manifest[field] === null) {
                throw new Error(
                    `[AdapterRegistry] Manifest validation failed for "${manifest.id ?? 'unknown'}": missing required field "${field}"`
                );
            }
        }

        if (!manifest.id || manifest.id.trim().length === 0) {
            throw new Error(
                '[AdapterRegistry] Manifest validation failed: id cannot be empty'
            );
        }

        const validSideEffects = ['none', 'reversible', 'irreversible'];
        if (!validSideEffects.includes(manifest.sideEffects)) {
            throw new Error(
                `[AdapterRegistry] Manifest validation failed for "${manifest.id}": ` +
                `sideEffects must be one of ${validSideEffects.join(', ')}, got "${manifest.sideEffects}"`
            );
        }
    }
}
