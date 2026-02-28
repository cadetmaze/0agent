/**
 * LLMRouter — Model selection, routing, and expert judgment lens application.
 *
 * This is the central routing layer between the orchestrator and LLM providers.
 * It classifies tasks, selects providers, applies the expert judgment lens,
 * and returns typed results — never raw strings.
 */

import type { LLMProvider } from './base.js';
import type {
    TaskEnvelope,
    TaggedMessage,
    CompletionResult,
    CompletionOptions,
    LensedResult,
    ClassifiedTask,
    TaskClassification,
    Constraint,
    Trigger,
    ConfidenceRange,
} from '../core/envelope.js';
import { buildConstraintRejectionMessage } from '../core/policy-engine.js';

// Re-export types consumed by the reinforcement overlay
export type { LLMProvider, ClassifiedTask, TaskClassification };

// ============================================================
// Router
// ============================================================

export class LLMRouter {
    private providers: Map<string, LLMProvider> = new Map();
    private routingRules: RoutingRule[] = [];

    /**
     * Register a provider with the router.
     */
    registerProvider(provider: LLMProvider): void {
        this.providers.set(provider.id, provider);
        console.log(`[LLMRouter] Registered provider: ${provider.name} (${provider.id})`);
    }

    /**
     * Get a specific provider by ID (for adaptive router overlay).
     */
    getProvider(id: string): LLMProvider | undefined {
        return this.providers.get(id);
    }

    /**
     * Add a routing rule that maps task classifications to preferred providers.
     */
    addRoutingRule(rule: RoutingRule): void {
        this.routingRules.push(rule);
    }

    /**
     * Classify a task spec to determine which type of model to use.
     */
    classifyTask(spec: string, envelope: TaskEnvelope): ClassifiedTask {
        // TODO: Replace with an LLM-based classifier or a more sophisticated heuristic.
        // Current implementation uses keyword-based classification.

        const specLower = spec.toLowerCase();

        let classification: TaskClassification = 'standard';
        let requiresLocalOnly = false;

        // Check for sensitive content indicators
        const sensitiveKeywords = ['password', 'credential', 'ssn', 'social security', 'credit card', 'private key'];
        if (sensitiveKeywords.some((kw) => specLower.includes(kw))) {
            classification = 'sensitive';
            requiresLocalOnly = true;
        }

        // Check for judgment-heavy indicators
        const judgmentKeywords = ['analyze', 'evaluate', 'recommend', 'strategy', 'decision', 'judgment', 'assess'];
        if (judgmentKeywords.some((kw) => specLower.includes(kw))) {
            classification = 'judgment_heavy';
        }

        // Check for fast/simple indicators
        const fastKeywords = ['format', 'convert', 'summarize briefly', 'extract', 'list'];
        if (fastKeywords.some((kw) => specLower.includes(kw)) && spec.length < 200) {
            classification = 'fast';
        }

        // Check envelope constraints
        if (envelope.expertJudgment.hardConstraints.length > 5) {
            // Many constraints suggest a complex task requiring strong reasoning
            if (classification === 'fast') classification = 'standard';
        }

        return {
            classification,
            estimatedComplexity: this.estimateComplexity(spec),
            requiresLocalOnly,
            spec,
        };
    }

    /**
     * Select the best provider for a classified task.
     */
    selectProvider(task: ClassifiedTask): LLMProvider {
        // Check routing rules first
        for (const rule of this.routingRules) {
            if (rule.classification === task.classification) {
                const provider = this.providers.get(rule.preferredProviderId);
                if (provider && provider.canHandle(task)) {
                    return provider;
                }
            }
        }

        // Fallback: find first provider that can handle the task
        for (const provider of this.providers.values()) {
            if (provider.canHandle(task)) {
                return provider;
            }
        }

        // Last resort: use the first available provider
        const firstProvider = this.providers.values().next().value;
        if (!firstProvider) {
            throw new Error('[LLMRouter] No providers registered');
        }
        return firstProvider;
    }

    /**
     * Route a request: classify, select provider, call, apply expert lens.
     *
     * This is the primary entry point. It:
     * 1. Classifies the task
     * 2. Selects the provider
     * 3. Injects hard constraints as a system message
     * 4. Makes the LLM call
     * 5. Applies the expert judgment lens
     * 6. Returns a LensedResult — never a raw string
     */
    async route(
        systemPrompt: string,
        messages: TaggedMessage[],
        options: CompletionOptions,
        envelope: TaskEnvelope
    ): Promise<LensedResult> {
        // Classify the task
        const classified = this.classifyTask(envelope.task.spec, envelope);

        // Select provider
        const provider = this.selectProvider(classified);
        console.log(
            `[LLMRouter] Routing to ${provider.name} (classification: ${classified.classification})`
        );

        // Inject hard constraints as a system message (Defense 3)
        const constraintMessage = buildConstraintRejectionMessage(
            envelope.expertJudgment.hardConstraints
        );
        const augmentedMessages = [constraintMessage, ...messages];

        // Make the LLM call
        const result = await provider.complete(systemPrompt, augmentedMessages, options);

        // Apply expert judgment lens
        const lensed = this.applyExpertLens(result, envelope);

        return lensed;
    }

    /**
     * Apply the expert judgment lens to LLM output.
     *
     * Checks the output against:
     * 1. Hard constraints — if violated, returns ConstraintViolation
     * 2. Confidence threshold — if below, sets requiresReview
     * 3. Escalation trigger patterns — if matched, sets escalate
     */
    applyExpertLens(
        output: CompletionResult,
        envelope: TaskEnvelope
    ): LensedResult {
        const { hardConstraints, escalationTriggers, confidenceMap } =
            envelope.expertJudgment;

        // Check hard constraints
        let constraintViolation = false;
        let violationDetails: string | undefined;

        for (const constraint of hardConstraints) {
            if (this.checkConstraintViolation(output.content, constraint)) {
                constraintViolation = true;
                violationDetails = `Output violates constraint "${constraint.id}": ${constraint.rule}`;
                break;
            }
        }

        // Check escalation triggers
        let escalate = false;
        let escalationReason: string | undefined;

        for (const trigger of escalationTriggers) {
            if (this.matchesTrigger(output.content, trigger)) {
                escalate = true;
                escalationReason = `Trigger matched: ${trigger.description}`;
                break;
            }
        }

        // Determine confidence and review requirement
        const confidenceScore = this.calculateConfidence(output);
        const requiresReview = this.shouldRequireReview(
            confidenceScore,
            confidenceMap
        );

        return {
            output: output.content,
            constraintViolation,
            violationDetails,
            requiresReview,
            escalate,
            escalationReason,
            confidenceScore,
        };
    }

    // ============================================================
    // Private helpers
    // ============================================================

    private estimateComplexity(spec: string): number {
        // Simple heuristic based on length and structure
        const words = spec.split(/\s+/).length;
        if (words < 20) return 1;
        if (words < 50) return 3;
        if (words < 100) return 5;
        if (words < 200) return 7;
        return 9;
    }

    private checkConstraintViolation(
        output: string,
        constraint: Constraint
    ): boolean {
        // TODO: Replace with semantic similarity or LLM-based checking.
        const outputLower = output.toLowerCase();
        const ruleKeywords = constraint.rule
            .toLowerCase()
            .split(/\s+/)
            .filter((w) => w.length > 3);

        const matchCount = ruleKeywords.filter((kw) => outputLower.includes(kw)).length;
        const matchRatio = ruleKeywords.length > 0 ? matchCount / ruleKeywords.length : 0;

        return matchRatio > 0.7;
    }

    private matchesTrigger(output: string, trigger: Trigger): boolean {
        const outputLower = output.toLowerCase();
        return trigger.patterns.some((p) => outputLower.includes(p.toLowerCase()));
    }

    private calculateConfidence(_output: CompletionResult): number {
        // TODO: Implement using model logprobs or a calibration model.
        return 0.75;
    }

    private shouldRequireReview(
        score: number,
        confidenceMap: ConfidenceRange[]
    ): boolean {
        for (const range of confidenceMap) {
            if (score >= range.min && score <= range.max) {
                return range.action !== 'act';
            }
        }
        return score < 0.5;
    }
}

// ============================================================
// Routing Rule Type
// ============================================================

export interface RoutingRule {
    classification: TaskClassification;
    preferredProviderId: string;
    fallbackProviderId?: string;
}
