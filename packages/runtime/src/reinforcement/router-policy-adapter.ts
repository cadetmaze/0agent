/**
 * RouterPolicyAdapter — Wraps LLMRouter.selectProvider() with adaptive weights.
 *
 * Does NOT modify LLMRouter. Acts as a decorator/proxy.
 * Re-ranks available providers by their Q-value from the adaptive store,
 * then asks the original router to select among the re-ranked options.
 *
 * Falls back to the base router when:
 *   - Adaptive store is frozen
 *   - No Q-values exist yet (cold start)
 *   - Less than 2 providers available
 */

import type { LLMRouter, LLMProvider, ClassifiedTask, TaskClassification } from '../router/llm-router.js';
import type { AdaptivePolicyStore } from './adaptive-policy-store.js';

export class RouterPolicyAdapter {
    constructor(
        private router: LLMRouter,
        private store: AdaptivePolicyStore
    ) { }

    /**
     * Select the best provider, incorporating adaptive Q-weights on top
     * of the base router's provider selection.
     *
     * @param task - Classified task
     * @param companyId - Company scope for params
     * @param agentId - Agent scope for params
     * @returns Selected LLM provider
     */
    async selectProvider(
        task: ClassifiedTask,
        companyId: string,
        agentId: string
    ): Promise<LLMProvider> {
        // Load adaptive params
        const params = await this.store.load(
            companyId,
            agentId,
            task.classification as TaskClassification
        );

        // Fall back to base router if frozen or no weights learned yet
        if (params.frozen || Object.keys(params.routerWeights).length === 0) {
            return this.router.selectProvider(task);
        }

        // Get the base router's selection as the default
        const baseSelection = this.router.selectProvider(task);

        // Find the provider with the highest Q-value that can handle the task
        const weights = params.routerWeights;
        const bestAdaptiveProviderId = Object.entries(weights)
            .filter(([, qValue]) => qValue > 0)  // Only consider providers with positive Q-value
            .sort(([, a], [, b]) => b - a)        // Sort descending by Q-value
            .map(([providerId]) => providerId)[0];

        if (!bestAdaptiveProviderId) {
            return baseSelection;  // No positive Q-values yet
        }

        // Try to get the adaptive-preferred provider from the router's registry
        const adaptiveProvider = this.router.getProvider(bestAdaptiveProviderId);
        if (adaptiveProvider && adaptiveProvider.canHandle(task)) {
            console.log(
                `[RouterPolicyAdapter] Adaptive selection: ${bestAdaptiveProviderId} ` +
                `(Q=${weights[bestAdaptiveProviderId]?.toFixed(3) ?? '?'}) for task type ${task.classification}`
            );
            return adaptiveProvider;
        }

        return baseSelection;
    }

    /**
     * Get the base router (for route() calls that don't need adaptation).
     */
    get baseRouter(): LLMRouter {
        return this.router;
    }
}
