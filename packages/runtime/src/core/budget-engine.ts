/**
 * BudgetEngine — Cost estimation and enforcement.
 *
 * Tracks spend per task and per agent. Prevents tasks from exceeding
 * their allocated budget. Works with the policy engine to block
 * over-budget operations.
 */

// ============================================================
// Types
// ============================================================

/** Cost breakdown for a single operation */
export interface CostRecord {
    taskId: string;
    agentId: string;
    operation: string;
    inputTokens: number;
    outputTokens: number;
    costDollars: number;
    timestamp: string;
}

/** Aggregated spend for an agent */
export interface AgentSpend {
    agentId: string;
    totalCostDollars: number;
    totalTokens: number;
    operationCount: number;
}

/** Budget check result */
export interface BudgetCheckResult {
    allowed: boolean;
    remainingDollars: number;
    estimatedCostDollars: number;
    reason?: string;
}

/** Session-level cost guard configuration */
export interface SessionCostGuard {
    /** Max total spend across all tasks in a session. Default: $50 */
    maxSessionSpendDollars: number;

    /** Per-hour rate limit. If spend exceeds this in a rolling hour, pause. Default: $20 */
    maxHourlySpendDollars: number;
}

// ============================================================
// Pricing table — cost per 1M tokens
// ============================================================

interface ModelPricing {
    inputPerMillionTokens: number;
    outputPerMillionTokens: number;
}

const MODEL_PRICING: Record<string, ModelPricing> = {
    'claude-sonnet-4-6': {
        inputPerMillionTokens: 3.0,
        outputPerMillionTokens: 15.0,
    },
    'claude-sonnet-4-20250514': {
        inputPerMillionTokens: 3.0,
        outputPerMillionTokens: 15.0,
    },
    'gpt-4o-mini': {
        inputPerMillionTokens: 0.15,
        outputPerMillionTokens: 0.6,
    },
    'gpt-4o': {
        inputPerMillionTokens: 2.5,
        outputPerMillionTokens: 10.0,
    },
    'local': {
        inputPerMillionTokens: 0,
        outputPerMillionTokens: 0,
    },
};

// ============================================================
// BudgetEngine Class
// ============================================================

export class BudgetEngine {
    private costRecords: CostRecord[] = [];
    private agentSpend: Map<string, AgentSpend> = new Map();
    private sessionGuard: SessionCostGuard;
    private sessionStartTime: number;

    constructor(sessionGuard?: Partial<SessionCostGuard>) {
        this.sessionGuard = {
            maxSessionSpendDollars: sessionGuard?.maxSessionSpendDollars ?? 50,
            maxHourlySpendDollars: sessionGuard?.maxHourlySpendDollars ?? 20,
        };
        this.sessionStartTime = Date.now();
    }

    /**
     * Estimate the cost of an LLM call before making it.
     */
    estimateCost(
        model: string,
        estimatedInputTokens: number,
        estimatedOutputTokens: number
    ): number {
        const pricing = MODEL_PRICING[model] ?? MODEL_PRICING['gpt-4o-mini']!;

        const inputCost =
            (estimatedInputTokens / 1_000_000) * pricing.inputPerMillionTokens;
        const outputCost =
            (estimatedOutputTokens / 1_000_000) * pricing.outputPerMillionTokens;

        return inputCost + outputCost;
    }

    /**
     * Check if a task can proceed within its budget.
     */
    checkBudget(
        taskId: string,
        agentId: string,
        maxSpendDollars: number,
        estimatedCostDollars: number
    ): BudgetCheckResult {
        // --- Per-task budget check ---
        const currentSpend = this.getTaskSpend(taskId);
        const remaining = maxSpendDollars - currentSpend;

        if (estimatedCostDollars > remaining) {
            return {
                allowed: false,
                remainingDollars: remaining,
                estimatedCostDollars,
                reason: `Estimated cost $${estimatedCostDollars.toFixed(4)} exceeds remaining budget $${remaining.toFixed(4)} for task ${taskId}`,
            };
        }

        // --- Session ceiling check ---
        const sessionSpend = this.getSessionSpend();
        if (sessionSpend + estimatedCostDollars > this.sessionGuard.maxSessionSpendDollars) {
            return {
                allowed: false,
                remainingDollars: this.sessionGuard.maxSessionSpendDollars - sessionSpend,
                estimatedCostDollars,
                reason: `Session cost ceiling reached. Total session spend: $${sessionSpend.toFixed(2)}, ceiling: $${this.sessionGuard.maxSessionSpendDollars}`,
            };
        }

        // --- Per-hour rate limit check ---
        const hourlySpend = this.getHourlySpend();
        if (hourlySpend + estimatedCostDollars > this.sessionGuard.maxHourlySpendDollars) {
            return {
                allowed: false,
                remainingDollars: this.sessionGuard.maxHourlySpendDollars - hourlySpend,
                estimatedCostDollars,
                reason: `Hourly rate limit reached. Spend in last hour: $${hourlySpend.toFixed(2)}, limit: $${this.sessionGuard.maxHourlySpendDollars}/hr`,
            };
        }

        return {
            allowed: true,
            remainingDollars: remaining,
            estimatedCostDollars,
        };
    }

    /**
     * Record a cost incurred by a task.
     */
    recordCost(record: CostRecord): void {
        this.costRecords.push(record);

        // Update agent-level aggregation
        const existing = this.agentSpend.get(record.agentId);
        if (existing) {
            existing.totalCostDollars += record.costDollars;
            existing.totalTokens += record.inputTokens + record.outputTokens;
            existing.operationCount += 1;
        } else {
            this.agentSpend.set(record.agentId, {
                agentId: record.agentId,
                totalCostDollars: record.costDollars,
                totalTokens: record.inputTokens + record.outputTokens,
                operationCount: 1,
            });
        }
    }

    /**
     * Get total spend for a specific task.
     */
    getTaskSpend(taskId: string): number {
        return this.costRecords
            .filter((r) => r.taskId === taskId)
            .reduce((sum, r) => sum + r.costDollars, 0);
    }

    /**
     * Get aggregated spend for an agent.
     */
    getAgentSpend(agentId: string): AgentSpend {
        return (
            this.agentSpend.get(agentId) ?? {
                agentId,
                totalCostDollars: 0,
                totalTokens: 0,
                operationCount: 0,
            }
        );
    }

    /**
     * Get all cost records (for telemetry/audit).
     */
    getAllRecords(): ReadonlyArray<CostRecord> {
        return this.costRecords;
    }

    // ============================================================
    // Session-level cost tracking
    // ============================================================

    /**
     * Get total spend across ALL tasks in this session.
     */
    getSessionSpend(): number {
        return this.costRecords.reduce((sum, r) => sum + r.costDollars, 0);
    }

    /**
     * Get spend in the last rolling hour.
     */
    getHourlySpend(): number {
        const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
        return this.costRecords
            .filter((r) => r.timestamp >= oneHourAgo)
            .reduce((sum, r) => sum + r.costDollars, 0);
    }

    /**
     * Get the session cost guard configuration.
     */
    getSessionGuard(): SessionCostGuard {
        return { ...this.sessionGuard };
    }
}
