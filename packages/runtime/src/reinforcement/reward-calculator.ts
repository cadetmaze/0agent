/**
 * RewardCalculator — Convert task execution telemetry into a reward vector.
 *
 * Reward = weighted sum of 5 normalized components:
 *
 *   1. outcome_delta         (0.40) — APL improvement vs baseline
 *   2. cost_efficiency       (0.20) — 1 - (actual/budget), how frugal
 *   3. escalation_precision  (0.20) — 1 if escalation confirmed warranted, 0 if wasted
 *   4. human_override_penalty(0.10) — negative if human had to override
 *   5. calibration_error     (0.10) — negative if confidence far from actual outcome
 *
 * All components normalized to [-1, 1] before weighting.
 */

// ============================================================
// Types
// ============================================================

export interface TaskExecutionEvent {
    taskId: string;
    agentId: string;
    companyId: string;
    taskType: string;           // TaskClassification
    providerId: string;         // Which LLM provider was used
    costDollars: number;        // Actual cost of this call
    budgetDollars: number;      // Allocated budget for this task
    confidenceScore: number;    // Model confidence at decision time (0-1)
    success: boolean;           // Did the task complete successfully?
    escalated: boolean;         // Was an approval requested?
    escalationConfirmed: boolean; // Was the escalation deemed necessary by reviewer?
    humanOverride: boolean;     // Did a human override the agent's output?
    aplDelta: number;           // APL change vs baseline (-1 to 1, can be NaN if unavailable)
    latencyMs: number;
}

export interface RewardVector {
    outcomeDelta: number;           // [-1, 1]
    costEfficiency: number;         // [-1, 1]
    escalationPrecision: number;    // [-1, 1]
    overridePenalty: number;        // [-1, 0]
    calibrationError: number;       // [-1, 0]
    total: number;                  // Weighted sum [-1, 1]
}

export interface RewardWeights {
    outcomeDelta: number;
    costEfficiency: number;
    escalationPrecision: number;
    overridePenalty: number;
    calibrationError: number;
}

export const DEFAULT_REWARD_WEIGHTS: RewardWeights = {
    outcomeDelta: 0.40,
    costEfficiency: 0.20,
    escalationPrecision: 0.20,
    overridePenalty: 0.10,
    calibrationError: 0.10,
};

// ============================================================
// RewardCalculator
// ============================================================

export class RewardCalculator {
    private weights: RewardWeights;

    constructor(weights?: Partial<RewardWeights>) {
        this.weights = { ...DEFAULT_REWARD_WEIGHTS, ...weights };
        this.validateWeights();
    }

    /**
     * Compute the reward vector for a completed task execution event.
     */
    compute(event: TaskExecutionEvent): RewardVector {
        const outcomeDelta = this.computeOutcomeDelta(event);
        const costEfficiency = this.computeCostEfficiency(event);
        const escalationPrecision = this.computeEscalationPrecision(event);
        const overridePenalty = this.computeOverridePenalty(event);
        const calibrationError = this.computeCalibrationError(event);

        const total =
            this.weights.outcomeDelta * outcomeDelta +
            this.weights.costEfficiency * costEfficiency +
            this.weights.escalationPrecision * escalationPrecision +
            this.weights.overridePenalty * overridePenalty +
            this.weights.calibrationError * calibrationError;

        // Clamp total to [-1, 1]
        const clampedTotal = Math.max(-1, Math.min(1, total));

        return {
            outcomeDelta,
            costEfficiency,
            escalationPrecision,
            overridePenalty,
            calibrationError,
            total: Math.round(clampedTotal * 10000) / 10000,
        };
    }

    // ============================================================
    // Component calculations
    // ============================================================

    /**
     * APL delta: how much did performance improve vs baseline?
     * If APL is unavailable (NaN), we use success/failure as a proxy.
     */
    private computeOutcomeDelta(event: TaskExecutionEvent): number {
        if (!isNaN(event.aplDelta)) {
            // Clamp APL delta to [-1, 1]
            return Math.max(-1, Math.min(1, event.aplDelta));
        }
        // Fallback: +1 for success, -0.5 for failure (partial credit for attempt)
        return event.success ? 0.5 : -0.5;
    }

    /**
     * Cost efficiency: how much of the budget was saved?
     * Negative if cost exceeded budget.
     */
    private computeCostEfficiency(event: TaskExecutionEvent): number {
        if (event.budgetDollars <= 0) return 0;
        const efficiency = 1 - (event.costDollars / event.budgetDollars);
        // Clamp to [-1, 1]: over-budget gives negative reward
        return Math.max(-1, Math.min(1, efficiency));
    }

    /**
     * Escalation precision: was the escalation warranted?
     * - No escalation → neutral (0)
     * - Escalation confirmed as necessary → +1
     * - Unnecessary escalation (reviewer auto-approved or task was routine) → -1
     */
    private computeEscalationPrecision(event: TaskExecutionEvent): number {
        if (!event.escalated) return 0;      // No escalation — neutral
        return event.escalationConfirmed ? 1.0 : -1.0;
    }

    /**
     * Override penalty: if a human had to override, the agent made a mistake.
     */
    private computeOverridePenalty(event: TaskExecutionEvent): number {
        return event.humanOverride ? -1.0 : 0.0;
    }

    /**
     * Calibration error: how far was the confidence from the actual outcome?
     * A well-calibrated agent that says 0.9 should succeed 90% of the time.
     */
    private computeCalibrationError(event: TaskExecutionEvent): number {
        const actualOutcome = event.success ? 1.0 : 0.0;
        const error = Math.abs(event.confidenceScore - actualOutcome);
        // Perfect calibration → 0, worst → -1
        return -error;
    }

    private validateWeights(): void {
        const sum = Object.values(this.weights).reduce((a, b) => a + b, 0);
        if (Math.abs(sum - 1.0) > 0.001) {
            throw new Error(
                `[RewardCalculator] Reward weights must sum to 1.0, got ${sum.toFixed(4)}`
            );
        }
    }
}
