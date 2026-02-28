/**
 * EscalationThresholdAdapter — Wraps escalation confidence check with adaptive delta.
 *
 * Does NOT modify PolicyEngine or LLMRouter. Acts as a thin advisor layer.
 *
 * The base escalation threshold is defined by the PolicyEngine.
 * This adapter shifts that threshold by escalationThresholdDelta (bounded ±0.2)
 * learned from real escalation outcome data.
 *
 * Example:
 *   Base threshold: 0.7 (escalate if confidence < 0.7)
 *   Delta learned: -0.05 (agent is slightly over-escalating)
 *   Effective threshold: 0.65 → agent escalates less often
 */

import type { AdaptivePolicyStore } from './adaptive-policy-store.js';
import type { TaskClassification } from '../router/llm-router.js';
import { PARAM_BOUNDS } from './adaptive-policy-store.js';

export class EscalationThresholdAdapter {
    constructor(private store: AdaptivePolicyStore) { }

    /**
     * Compute the effective escalation threshold for this agent+task type.
     *
     * @param baseThreshold - The PolicyEngine's base confidence threshold
     * @param companyId - Company scope
     * @param agentId - Agent scope
     * @param taskType - Task classification to look up learned delta
     * @returns Adjusted threshold (clamped to [0.3, 0.95] to prevent extremes)
     */
    async effectiveThreshold(
        baseThreshold: number,
        companyId: string,
        agentId: string,
        taskType: TaskClassification
    ): Promise<number> {
        const params = await this.store.load(companyId, agentId, taskType);

        // If frozen, return base threshold unchanged
        if (params.frozen) return baseThreshold;

        // Validate delta is within bounds
        const delta = Math.max(
            PARAM_BOUNDS.escalationThresholdDelta.min,
            Math.min(PARAM_BOUNDS.escalationThresholdDelta.max, params.escalationThresholdDelta)
        );

        const effective = baseThreshold + delta;

        // Clamp effective threshold to reasonable range — never allow extremes
        const clamped = Math.max(0.30, Math.min(0.95, effective));

        if (Math.abs(delta) > 0.01) {
            console.log(
                `[EscalationThresholdAdapter] Effective threshold: ${baseThreshold.toFixed(2)} + ` +
                `${delta.toFixed(3)} = ${clamped.toFixed(3)} (task: ${taskType})`
            );
        }

        return clamped;
    }

    /**
     * Determine whether a task should be escalated using the adaptive threshold.
     *
     * @param confidenceScore - LLM's confidence at decision time
     * @param baseThreshold - PolicyEngine's base threshold
     * @param companyId - Company scope
     * @param agentId - Agent scope
     * @param taskType - Task classification
     * @returns true if the task should be escalated
     */
    async shouldEscalate(
        confidenceScore: number,
        baseThreshold: number,
        companyId: string,
        agentId: string,
        taskType: TaskClassification
    ): Promise<boolean> {
        const threshold = await this.effectiveThreshold(
            baseThreshold,
            companyId,
            agentId,
            taskType
        );
        return confidenceScore < threshold;
    }
}
