/**
 * Local Provider — Ollama adapter for local/private model inference.
 *
 * Calls Ollama at a configurable base URL. Used for sensitive tasks
 * that should never leave the local machine.
 */

import type { LLMProvider } from '../base.js';
import type {
    TaggedMessage,
    CompletionResult,
    CompletionOptions,
    CostEstimate,
    ClassifiedTask,
    ProviderHealth,
} from '../../core/envelope.js';

const DEFAULT_BASE_URL = 'http://localhost:11434';
const DEFAULT_MODEL = 'llama3';

interface OllamaChatResponse {
    message?: { content?: string };
    prompt_eval_count?: number;
    eval_count?: number;
    done?: boolean;
}

export class LocalProvider implements LLMProvider {
    id = 'local';
    name = 'Local (Ollama)';

    private baseUrl: string;
    private model: string;

    constructor(baseUrl?: string, model?: string) {
        this.baseUrl = baseUrl ?? process.env['OLLAMA_BASE_URL'] ?? DEFAULT_BASE_URL;
        this.model = model ?? process.env['OLLAMA_MODEL'] ?? DEFAULT_MODEL;
    }

    canHandle(task: ClassifiedTask): boolean {
        // Local provider handles sensitive tasks and fast tasks when available.
        return (
            task.classification === 'sensitive' ||
            task.requiresLocalOnly
        );
    }

    estimateCost(_prompt: string, _maxTokens: number): CostEstimate {
        // Local models are free (no API costs)
        return {
            estimatedInputTokens: 0,
            estimatedOutputTokens: 0,
            estimatedCostDollars: 0,
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

        // Build Ollama chat messages
        const ollamaMessages: Array<{ role: string; content: string }> = [
            { role: 'system', content: systemPrompt },
        ];

        for (const msg of messages) {
            ollamaMessages.push({
                role: msg.role === 'assistant' ? 'assistant' : msg.role === 'system' ? 'system' : 'user',
                content: msg.content,
            });
        }

        try {
            const response = await fetch(`${this.baseUrl}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: this.model,
                    messages: ollamaMessages,
                    stream: false,
                    options: {
                        temperature: options.temperature,
                        num_predict: options.maxTokens,
                        stop: options.stopSequences,
                    },
                }),
            });

            if (!response.ok) {
                throw new Error(`Ollama returned ${response.status}: ${response.statusText}`);
            }

            const data = (await response.json()) as OllamaChatResponse;
            const content = data.message?.content ?? '';

            return {
                content,
                model: this.model,
                provider: this.id,
                inputTokens: data.prompt_eval_count ?? 0,
                outputTokens: data.eval_count ?? 0,
                costDollars: 0,
                latencyMs: Date.now() - startTime,
                stopReason: 'end_turn',
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            throw new Error(`[LocalProvider] Completion failed: ${message}`);
        }
    }

    async health(): Promise<ProviderHealth> {
        const startTime = Date.now();
        try {
            const response = await fetch(`${this.baseUrl}/api/tags`);
            return {
                available: response.ok,
                latencyMs: Date.now() - startTime,
                errorRate: response.ok ? 0 : 1,
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
