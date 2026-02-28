/**
 * LLMProvider Interface — implement to add a new model provider.
 *
 * Every provider exposes cost estimation, health checks, and a typed
 * completion method that accepts TaggedMessages (never raw strings).
 */

import type {
    TaggedMessage,
    CompletionResult,
    CompletionOptions,
    CostEstimate,
    ClassifiedTask,
    ProviderHealth,
} from '../core/envelope.js';

// ============================================================
// LLM Provider Interface
// ============================================================

export interface LLMProvider {
    /** Unique identifier for this provider */
    id: string;
    /** Human-readable name */
    name: string;

    /**
     * Returns true if this provider can handle this task type.
     * Used by the router to match tasks to providers.
     */
    canHandle(task: ClassifiedTask): boolean;

    /**
     * Estimate cost before calling the provider.
     */
    estimateCost(prompt: string, maxTokens: number): CostEstimate;

    /**
     * The actual LLM call.
     * Receives TaggedMessages — never raw strings.
     * The system prompt and constraint re-injection message are separate.
     */
    complete(
        systemPrompt: string,
        messages: TaggedMessage[],
        options: CompletionOptions
    ): Promise<CompletionResult>;

    /**
     * Health check — returns provider availability and latency info.
     */
    health(): Promise<ProviderHealth>;
}
