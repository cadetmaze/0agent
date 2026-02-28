/**
 * OpenAI Provider — GPT adapter.
 *
 * Uses the openai package, defaults to gpt-4o-mini.
 * All external content arrives as TaggedMessages, not raw strings.
 */

import OpenAI from 'openai';
import type { LLMProvider } from '../base.js';
import type {
    TaggedMessage,
    CompletionResult,
    CompletionOptions,
    CostEstimate,
    ClassifiedTask,
    ProviderHealth,
} from '../../core/envelope.js';

const DEFAULT_MODEL = 'gpt-4o-mini';

// Pricing per 1M tokens (gpt-4o-mini)
const INPUT_COST_PER_M = 0.15;
const OUTPUT_COST_PER_M = 0.6;

export class OpenAIProvider implements LLMProvider {
    id = 'openai';
    name = 'OpenAI (GPT)';

    private client: OpenAI;
    private model: string;

    constructor(apiKey?: string, model?: string) {
        this.model = model ?? DEFAULT_MODEL;
        this.client = new OpenAI({
            apiKey: apiKey ?? process.env['OPENAI_API_KEY'],
        });
    }

    canHandle(task: ClassifiedTask): boolean {
        // OpenAI handles standard and fast tasks.
        // Not for sensitive (use local) or judgment-heavy (use Claude).
        return (
            task.classification === 'standard' ||
            task.classification === 'fast'
        );
    }

    estimateCost(prompt: string, maxTokens: number): CostEstimate {
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

        // Convert TaggedMessages to OpenAI format
        const openaiMessages: OpenAI.ChatCompletionMessageParam[] = [
            { role: 'system', content: systemPrompt },
        ];

        // Add system-tagged messages
        for (const msg of messages) {
            if (msg.role === 'system') {
                openaiMessages.push({ role: 'system', content: msg.content });
            }
        }

        // Add non-system messages
        for (const msg of messages) {
            if (msg.role !== 'system') {
                openaiMessages.push({
                    role: msg.role === 'assistant' ? 'assistant' : 'user',
                    content: msg.content,
                });
            }
        }

        try {
            const response = await this.client.chat.completions.create({
                model: this.model,
                messages: openaiMessages,
                max_tokens: options.maxTokens,
                temperature: options.temperature,
                stop: options.stopSequences,
            });

            const choice = response.choices[0];
            const content = choice?.message?.content ?? '';
            const usage = response.usage;

            return {
                content,
                model: response.model,
                provider: this.id,
                inputTokens: usage?.prompt_tokens ?? 0,
                outputTokens: usage?.completion_tokens ?? 0,
                costDollars:
                    ((usage?.prompt_tokens ?? 0) / 1_000_000) * INPUT_COST_PER_M +
                    ((usage?.completion_tokens ?? 0) / 1_000_000) * OUTPUT_COST_PER_M,
                latencyMs: Date.now() - startTime,
                stopReason:
                    choice?.finish_reason === 'length' ? 'max_tokens' : 'end_turn',
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            throw new Error(`[OpenAIProvider] Completion failed: ${message}`);
        }
    }

    async health(): Promise<ProviderHealth> {
        const startTime = Date.now();
        try {
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
