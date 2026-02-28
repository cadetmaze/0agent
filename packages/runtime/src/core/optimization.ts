/**
 * Optimization — Company optimization mode for agent behavior.
 *
 * When a company sets their optimization mode, it affects:
 * 1. LLM model selection (cheaper models for cost mode)
 * 2. Capability selection (prefer lower-cost adapters)
 * 3. Agent coordination (batch more aggressively in cost mode)
 * 4. Quality thresholds (higher review bar in quality mode)
 *
 * Modes:
 * - quality: always use the best model/capability regardless of cost
 * - cost: minimize spend, use cheaper alternatives when possible
 * - balanced: default — optimize for value (quality per dollar)
 * - speed: minimize latency, use fastest models/capabilities
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { TaskClassification } from './envelope.js';

// ============================================================
// Types
// ============================================================

export type OptimizationMode = 'quality' | 'cost' | 'balanced' | 'speed';

export interface OptimizationConfig {
    /** Primary optimization target */
    mode: OptimizationMode;

    /** Maximum cost per task in dollars (0 = no limit) */
    maxCostPerTask: number;

    /** Minimum quality score to accept (0-1) */
    minQualityThreshold: number;

    /** Maximum latency in ms before preferring faster model (0 = no limit) */
    maxLatencyMs: number;

    /** Whether to batch similar tasks for cost efficiency */
    enableBatching: boolean;

    /** Custom overrides per capability category */
    categoryOverrides: Record<string, Partial<OptimizationConfig>>;
}

export interface OptimizationHints {
    /** Suggested model tier based on optimization mode */
    preferredModelTier: 'premium' | 'standard' | 'economy';
    /** Suggested task classification override */
    classificationOverride: TaskClassification | null;
    /** Cost multiplier (1.0 = normal, 0.5 = try to halve cost) */
    costMultiplier: number;
    /** Quality bar (0-1, higher = stricter review) */
    qualityBar: number;
    /** Whether to skip optional capabilities to save cost */
    skipOptionalCapabilities: boolean;
    /** Whether to prefer local models for speed */
    preferLocalModels: boolean;
}

// ============================================================
// Default configs per mode
// ============================================================

const MODE_DEFAULTS: Record<OptimizationMode, OptimizationConfig> = {
    quality: {
        mode: 'quality',
        maxCostPerTask: 0,
        minQualityThreshold: 0.85,
        maxLatencyMs: 0,
        enableBatching: false,
        categoryOverrides: {},
    },
    cost: {
        mode: 'cost',
        maxCostPerTask: 0.50,
        minQualityThreshold: 0.6,
        maxLatencyMs: 0,
        enableBatching: true,
        categoryOverrides: {},
    },
    balanced: {
        mode: 'balanced',
        maxCostPerTask: 2.0,
        minQualityThreshold: 0.7,
        maxLatencyMs: 0,
        enableBatching: false,
        categoryOverrides: {},
    },
    speed: {
        mode: 'speed',
        maxCostPerTask: 5.0,
        minQualityThreshold: 0.5,
        maxLatencyMs: 5000,
        enableBatching: false,
        categoryOverrides: {},
    },
};

// ============================================================
// OptimizationEngine
// ============================================================

export class OptimizationEngine {
    private supabase: SupabaseClient;
    private configCache: Map<string, OptimizationConfig> = new Map();

    constructor(supabase: SupabaseClient) {
        this.supabase = supabase;
    }

    /**
     * Load optimization config for a company.
     * Falls back to 'balanced' if not configured.
     */
    async loadConfig(companyId: string): Promise<OptimizationConfig> {
        const cached = this.configCache.get(companyId);
        if (cached) return cached;

        const { data, error } = await this.supabase
            .from('companies')
            .select('optimization_mode, optimization_config')
            .eq('id', companyId)
            .single();

        if (error || !data) {
            return MODE_DEFAULTS.balanced;
        }

        const mode = (data.optimization_mode as OptimizationMode) ?? 'balanced';
        const baseConfig = { ...MODE_DEFAULTS[mode] };

        // Merge company-specific overrides
        const overrides = data.optimization_config as Partial<OptimizationConfig> | null;
        if (overrides) {
            Object.assign(baseConfig, overrides);
        }

        baseConfig.mode = mode;
        this.configCache.set(companyId, baseConfig);
        return baseConfig;
    }

    /**
     * Generate optimization hints for a specific task.
     *
     * These hints are consumed by:
     * - LLM Router (model selection)
     * - Adapter Registry (capability selection)
     * - Orchestrator (batching decisions)
     * - Policy Engine (approval thresholds)
     */
    getHints(config: OptimizationConfig, taskClassification: TaskClassification): OptimizationHints {
        switch (config.mode) {
            case 'quality':
                return {
                    preferredModelTier: 'premium',
                    classificationOverride:
                        taskClassification === 'fast' ? 'standard' : null,
                    costMultiplier: 1.5,
                    qualityBar: config.minQualityThreshold,
                    skipOptionalCapabilities: false,
                    preferLocalModels: false,
                };

            case 'cost':
                return {
                    preferredModelTier: 'economy',
                    classificationOverride:
                        taskClassification === 'judgment_heavy' ? null : 'fast',
                    costMultiplier: 0.5,
                    qualityBar: config.minQualityThreshold,
                    skipOptionalCapabilities: true,
                    preferLocalModels: true,
                };

            case 'speed':
                return {
                    preferredModelTier: 'standard',
                    classificationOverride: null,
                    costMultiplier: 1.0,
                    qualityBar: config.minQualityThreshold,
                    skipOptionalCapabilities: true,
                    preferLocalModels: true,
                };

            case 'balanced':
            default:
                return {
                    preferredModelTier: 'standard',
                    classificationOverride: null,
                    costMultiplier: 1.0,
                    qualityBar: config.minQualityThreshold,
                    skipOptionalCapabilities: false,
                    preferLocalModels: false,
                };
        }
    }

    /**
     * Suggest capabilities for a task based on optimization mode.
     *
     * In cost mode: prefer adapters with lower cost_tier
     * In quality mode: prefer adapters with higher quality_tier
     * In speed mode: prefer local/built-in adapters
     */
    async suggestCapabilities(
        companyId: string,
        requiredCategories: string[]
    ): Promise<Array<{ name: string; category: string; costTier: string; qualityTier: string; reason: string }>> {
        const config = await this.loadConfig(companyId);

        const { data, error } = await this.supabase
            .from('capability_registry')
            .select('*')
            .eq('enabled', true)
            .in('category', requiredCategories);

        if (error || !data) return [];

        // Filter by company overrides
        const { data: overrides } = await this.supabase
            .from('company_capability_overrides')
            .select('capability_id, enabled')
            .eq('company_id', companyId);

        const disabledIds = new Set(
            (overrides ?? [])
                .filter((o) => !(o.enabled as boolean))
                .map((o) => o.capability_id as string)
        );

        const available = data.filter((cap) => !disabledIds.has(cap.id as string));

        // Sort based on optimization mode
        const sorted = available.sort((a, b) => {
            if (config.mode === 'cost') {
                return this.costTierRank(a.cost_tier as string) - this.costTierRank(b.cost_tier as string);
            }
            if (config.mode === 'quality') {
                return this.qualityTierRank(b.quality_tier as string) - this.qualityTierRank(a.quality_tier as string);
            }
            return 0;
        });

        return sorted.map((cap) => ({
            name: cap.name as string,
            category: cap.category as string,
            costTier: cap.cost_tier as string,
            qualityTier: cap.quality_tier as string,
            reason: config.mode === 'cost'
                ? `Selected for cost efficiency (${cap.cost_tier as string} tier)`
                : config.mode === 'quality'
                    ? `Selected for quality (${cap.quality_tier as string} tier)`
                    : `Balanced selection`,
        }));
    }

    // ============================================================
    // Helpers
    // ============================================================

    private costTierRank(tier: string): number {
        const ranks: Record<string, number> = { free: 0, low: 1, standard: 2, high: 3, premium: 4 };
        return ranks[tier] ?? 2;
    }

    private qualityTierRank(tier: string): number {
        const ranks: Record<string, number> = { basic: 0, standard: 1, high: 2, premium: 3 };
        return ranks[tier] ?? 1;
    }

    clearCache(): void {
        this.configCache.clear();
    }
}
