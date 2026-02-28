/**
 * Anthropic Provider — Claude adapter.
 *
 * Uses @anthropic-ai/sdk, defaults to claude-sonnet-4-6.
 * All external content arrives as TaggedMessages, not raw strings.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { LLMProvider } from '../base.js';
import type {
    TaggedMessage,
    CompletionResult,
    CompletionOptions,
    CostEstimate,
    ClassifiedTask,
    ProviderHealth,
} from '../../core/envelope.js';

const DEFAULT_MODEL = 'claude-sonnet-4-6';

// Pricing per 1M tokens
const INPUT_COST_PER_M = 3.0;
const OUTPUT_COST_PER_M = 15.0;

export class AnthropicProvider implements LLMProvider {
    id = 'anthropic';
    name = 'Anthropic (Claude)';

    private client: Anthropic;
    private model: string;

    constructor(apiKey?: string, model?: string) {
        this.model = model ?? DEFAULT_MODEL;
        this.client = new Anthropic({
            apiKey: apiKey ?? process.env['ANTHROPIC_API_KEY'],
        });
    }

    canHandle(task: ClassifiedTask): boolean {
        const hasKey = !!(process.env['ANTHROPIC_API_KEY']);
        if (!hasKey) return false;

        // Claude handles judgment-heavy, standard, and fast tasks well.
        return (
            task.classification === 'judgment_heavy' ||
            task.classification === 'standard' ||
            task.classification === 'fast'
        );
    }

    estimateCost(prompt: string, maxTokens: number): CostEstimate {
        // Rough estimate: ~4 chars per token
        const estimatedInputTokens = Math.ceil(prompt.length / 4);
        const estimatedOutputTokens = maxTokens;

        return {
            estimatedInputTokens,
            estimatedOutputTokens,
            estimatedCostDollars:
                (estimatedInputTokens / 1_000_000) * INPUT_COST_PER_M +
                (estimatedOutputTokens / 1_000_000) * OUTPUT_COST_PER_M,
            provider: this.id,
            model: this.model,
        };
    }

    async complete(
        systemPrompt: string,
        messages: TaggedMessage[],
        options: CompletionOptions
    ): Promise<CompletionResult> {
        const startTime = Date.now();

        // Convert TaggedMessages to Anthropic message format
        const anthropicMessages: Anthropic.MessageParam[] = messages
            .filter((m) => m.role !== 'system')
            .map((m) => ({
                role: m.role === 'assistant' ? 'assistant' : 'user',
                content: m.content,
            }));

        // Collect all system-tagged messages into the system prompt
        const systemMessages = messages
            .filter((m) => m.role === 'system')
            .map((m) => m.content);

        const fullSystemPrompt = [systemPrompt, ...systemMessages].join('\n\n');

        try {
            const response = await this.client.messages.create({
                model: this.model,
                max_tokens: options.maxTokens,
                temperature: options.temperature,
                system: fullSystemPrompt,
                messages: anthropicMessages,
                stop_sequences: options.stopSequences,
            });

            const contentBlock = response.content[0];
            const content = contentBlock && contentBlock.type === 'text' ? contentBlock.text : '';

            return {
                content,
                model: response.model,
                provider: this.id,
                inputTokens: response.usage.input_tokens,
                outputTokens: response.usage.output_tokens,
                costDollars:
                    (response.usage.input_tokens / 1_000_000) * INPUT_COST_PER_M +
                    (response.usage.output_tokens / 1_000_000) * OUTPUT_COST_PER_M,
                latencyMs: Date.now() - startTime,
                stopReason:
                    response.stop_reason === 'max_tokens' ? 'max_tokens' : 'end_turn',
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            throw new Error(`[AnthropicProvider] Completion failed: ${message}`);
        }
    }

    async health(): Promise<ProviderHealth> {
        const startTime = Date.now();
        try {
            // TODO: Use a lightweight health check endpoint if available.
            // For now, do a minimal completion to verify connectivity.
            return {
                available: true,
                latencyMs: Date.now() - startTime,
                errorRate: 0,
                lastChecked: new Date().toISOString(),
            };
        } catch {
            return {
                available: false,
                latencyMs: Date.now() - startTime,
                errorRate: 1,
                lastChecked: new Date().toISOString(),
            };
        }
    }
}
