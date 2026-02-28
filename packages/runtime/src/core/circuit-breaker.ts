/**
 * Circuit Breaker — prevents runaway agent behavior.
 *
 * Agentic LLM systems have failure modes that don't throw errors:
 * the model produces output that *looks correct* but burns tokens
 * indefinitely. This module guards against those failures.
 *
 * Three sub-breakers:
 *   1. IterationBreaker  — hard/soft limits on LLM calls per task
 *   2. DuplicateDetector — catches near-identical outputs (Jaccard similarity)
 *   3. ProviderHealthTracker — classic circuit breaker per LLM provider
 *
 * Usage:
 *   const breaker = new CircuitBreaker(config);
 *   breaker.beforeIteration(taskId, llmOutput);       // throws on trip
 *   breaker.recordProviderCall(providerId, latencyMs, success);
 *   breaker.isProviderHealthy(providerId);             // boolean
 */

// ============================================================
// Configuration
// ============================================================

export interface CircuitBreakerConfig {
    /** Max LLM iterations per task before hard kill. Default: 25 */
    maxIterationsPerTask: number;

    /** Soft warning at this percentage of max. Default: 0.8 (80%) */
    softTripRatio: number;

    /** Consecutive iterations without tool calls before trip. Default: 5 */
    maxNoProgressStreak: number;

    /** Jaccard similarity threshold for near-duplicate detection. Default: 0.85 */
    duplicateSimilarityThreshold: number;

    /** Number of recent outputs to keep for duplicate detection. Default: 5 */
    duplicateWindowSize: number;

    /** Provider circuit breaker: error rate threshold (0-1). Default: 0.5 */
    providerErrorRateThreshold: number;

    /** Provider circuit breaker: latency threshold in ms. Default: 30_000 */
    providerLatencyThresholdMs: number;

    /** Provider circuit breaker: rolling window size in ms. Default: 60_000 */
    providerWindowMs: number;

    /** Provider circuit breaker: recovery probe delay in ms. Default: 30_000 */
    providerRecoveryDelayMs: number;

    /** Min samples before provider health evaluation kicks in. Default: 5 */
    providerMinSamples: number;

    /** Words to exclude from Jaccard similarity (common boilerplate). */
    duplicateStopWords: Set<string>;
}

export const DEFAULT_CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig = {
    maxIterationsPerTask: 25,
    softTripRatio: 0.8,
    maxNoProgressStreak: 5,
    duplicateSimilarityThreshold: 0.85,
    duplicateWindowSize: 5,
    providerErrorRateThreshold: 0.5,
    providerLatencyThresholdMs: 30_000,
    providerWindowMs: 60_000,
    providerRecoveryDelayMs: 30_000,
    providerMinSamples: 5,
    duplicateStopWords: new Set([
        'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been',
        'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will',
        'would', 'could', 'should', 'may', 'might', 'shall', 'can',
        'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from',
        'and', 'or', 'but', 'not', 'this', 'that', 'it', 'i',
    ]),
};

// ============================================================
// Types
// ============================================================

export type BreakerState = 'closed' | 'open' | 'half_open';

export type TripReason =
    | 'max_iterations'
    | 'duplicate_output'
    | 'no_progress'
    | 'cost_runaway'
    | 'provider_degraded'
    | 'cascade_failure'
    | 'timeout';

export interface TripEvent {
    taskId: string;
    reason: TripReason;
    severity: 'soft' | 'hard';
    iteration: number;
    message: string;
    timestamp: string;
    details?: Record<string, unknown>;
}

export interface IterationState {
    taskId: string;
    count: number;
    noProgressStreak: number;
    recentOutputs: string[];
    startedAt: string;
    lastOutputAt: string;
    tripped: boolean;
    tripEvents: TripEvent[];
}

interface ProviderCallRecord {
    timestamp: number;
    latencyMs: number;
    success: boolean;
}

interface ProviderState {
    providerId: string;
    state: BreakerState;
    calls: ProviderCallRecord[];
    openedAt: number | null;
    lastProbeAt: number | null;
}

// ============================================================
// Circuit Breaker Error
// ============================================================

export class CircuitBreakerTripped extends Error {
    public readonly tripEvent: TripEvent;

    constructor(event: TripEvent) {
        super(`[CircuitBreaker] TRIPPED — ${event.reason}: ${event.message}`);
        this.name = 'CircuitBreakerTripped';
        this.tripEvent = event;
    }
}

// ============================================================
// Circuit Breaker
// ============================================================

export class CircuitBreaker {
    private config: CircuitBreakerConfig;
    private tasks: Map<string, IterationState> = new Map();
    private providers: Map<string, ProviderState> = new Map();

    constructor(config?: Partial<CircuitBreakerConfig>) {
        this.config = { ...DEFAULT_CIRCUIT_BREAKER_CONFIG, ...config };
    }

    // ============================================================
    // Iteration Breaker — call before each LLM iteration
    // ============================================================

    /**
     * Call before every LLM iteration for a task.
     *
     * Returns a TripEvent with severity 'soft' if a warning should
     * be injected (e.g. "produce final answer NOW").
     * Throws CircuitBreakerTripped on hard trip.
     *
     * @param taskId - Unique task identifier
     * @param lastOutput - The LLM's output from the previous iteration (empty string on first)
     * @param hadToolCall - Whether the previous iteration included a tool call
     */
    beforeIteration(
        taskId: string,
        lastOutput: string = '',
        hadToolCall: boolean = true,
    ): TripEvent | null {
        let state = this.tasks.get(taskId);

        if (!state) {
            state = {
                taskId,
                count: 0,
                noProgressStreak: 0,
                recentOutputs: [],
                startedAt: new Date().toISOString(),
                lastOutputAt: new Date().toISOString(),
                tripped: false,
                tripEvents: [],
            };
            this.tasks.set(taskId, state);
        }

        state.count++;
        state.lastOutputAt = new Date().toISOString();

        // --- Check 1: Hard iteration limit ---
        if (state.count >= this.config.maxIterationsPerTask) {
            const event = this.createTripEvent(
                taskId,
                'max_iterations',
                'hard',
                state.count,
                `Hard iteration limit reached (${state.count}/${this.config.maxIterationsPerTask})`,
                { maxIterations: this.config.maxIterationsPerTask },
            );
            state.tripped = true;
            state.tripEvents.push(event);
            throw new CircuitBreakerTripped(event);
        }

        // --- Check 2: No-progress streak ---
        if (hadToolCall) {
            state.noProgressStreak = 0;
        } else {
            state.noProgressStreak++;
        }

        if (state.noProgressStreak >= this.config.maxNoProgressStreak) {
            const event = this.createTripEvent(
                taskId,
                'no_progress',
                'hard',
                state.count,
                `No tool calls for ${state.noProgressStreak} consecutive iterations — agent is stuck in a reasoning loop`,
                { streak: state.noProgressStreak },
            );
            state.tripped = true;
            state.tripEvents.push(event);
            throw new CircuitBreakerTripped(event);
        }

        // --- Check 3: Near-duplicate detection ---
        if (lastOutput.length > 0) {
            const duplicate = this.checkDuplicate(state, lastOutput);
            if (duplicate) {
                const event = this.createTripEvent(
                    taskId,
                    'duplicate_output',
                    'hard',
                    state.count,
                    `Near-duplicate output detected (${(duplicate.similarity * 100).toFixed(0)}% similar to iteration ${duplicate.matchedIndex + 1})`,
                    { similarity: duplicate.similarity, matchedIndex: duplicate.matchedIndex },
                );
                state.tripped = true;
                state.tripEvents.push(event);
                throw new CircuitBreakerTripped(event);
            }

            // Store output in window (after check, to avoid self-match)
            state.recentOutputs.push(lastOutput);
            if (state.recentOutputs.length > this.config.duplicateWindowSize) {
                state.recentOutputs.shift();
            }
        }

        // --- Check 4: Soft warning at threshold ---
        const softThreshold = Math.floor(
            this.config.maxIterationsPerTask * this.config.softTripRatio
        );
        if (state.count === softThreshold) {
            const event = this.createTripEvent(
                taskId,
                'max_iterations',
                'soft',
                state.count,
                `Approaching iteration limit (${state.count}/${this.config.maxIterationsPerTask}). ` +
                'You MUST produce a final actionable response within the next few iterations.',
                { threshold: softThreshold },
            );
            state.tripEvents.push(event);
            return event;  // Caller should inject this as system message
        }

        // --- Check 5: Soft warning for no-progress approaching ---
        const noProgressWarningAt = this.config.maxNoProgressStreak - 1;
        if (state.noProgressStreak === noProgressWarningAt && noProgressWarningAt > 0) {
            const event = this.createTripEvent(
                taskId,
                'no_progress',
                'soft',
                state.count,
                `You have not called any tools for ${state.noProgressStreak} iterations. ` +
                'You MUST call a tool or produce a final response in the next iteration, or this task will be terminated.',
                { streak: state.noProgressStreak },
            );
            state.tripEvents.push(event);
            return event;
        }

        return null;
    }

    /**
     * Mark a task as completed — cleans up tracking state.
     */
    taskCompleted(taskId: string): void {
        this.tasks.delete(taskId);
    }

    /**
     * Get the current iteration state for a task (for telemetry).
     */
    getTaskState(taskId: string): IterationState | undefined {
        return this.tasks.get(taskId);
    }

    // ============================================================
    // Duplicate Detector — Jaccard similarity on word sets
    // ============================================================

    private checkDuplicate(
        state: IterationState,
        newOutput: string,
    ): { similarity: number; matchedIndex: number } | null {
        const newWords = this.tokenize(newOutput);

        for (let i = 0; i < state.recentOutputs.length; i++) {
            const existingWords = this.tokenize(state.recentOutputs[i]!);
            const similarity = this.jaccard(newWords, existingWords);

            if (similarity >= this.config.duplicateSimilarityThreshold) {
                return { similarity, matchedIndex: i };
            }
        }

        return null;
    }

    /**
     * Tokenize a string into a set of lowercase words,
     * removing stop words to reduce false positives.
     */
    private tokenize(text: string): Set<string> {
        const words = text
            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, ' ')
            .split(/\s+/)
            .filter((w) => w.length > 1 && !this.config.duplicateStopWords.has(w));

        return new Set(words);
    }

    /**
     * Jaccard similarity: |A ∩ B| / |A ∪ B|
     */
    private jaccard(a: Set<string>, b: Set<string>): number {
        if (a.size === 0 && b.size === 0) return 1.0;
        if (a.size === 0 || b.size === 0) return 0.0;

        let intersection = 0;
        for (const word of a) {
            if (b.has(word)) intersection++;
        }

        const union = a.size + b.size - intersection;
        return union > 0 ? intersection / union : 0;
    }

    // ============================================================
    // Provider Health Tracker — classic circuit breaker pattern
    // ============================================================

    /**
     * Record the result of an LLM provider call.
     */
    recordProviderCall(
        providerId: string,
        latencyMs: number,
        success: boolean,
    ): void {
        let prov = this.providers.get(providerId);
        if (!prov) {
            prov = {
                providerId,
                state: 'closed',
                calls: [],
                openedAt: null,
                lastProbeAt: null,
            };
            this.providers.set(providerId, prov);
        }

        const now = Date.now();
        prov.calls.push({ timestamp: now, latencyMs, success });

        // Prune calls outside the rolling window
        const windowStart = now - this.config.providerWindowMs;
        prov.calls = prov.calls.filter((c) => c.timestamp >= windowStart);

        // Evaluate health
        this.evaluateProviderHealth(prov);
    }

    /**
     * Check if a provider is healthy enough to route to.
     */
    isProviderHealthy(providerId: string): boolean {
        const prov = this.providers.get(providerId);
        if (!prov) return true; // Unknown provider = assume healthy

        if (prov.state === 'closed') return true;

        if (prov.state === 'half_open') {
            // Allow one probe request
            return true;
        }

        // State is 'open' — check if recovery delay has elapsed
        if (prov.openedAt !== null) {
            const elapsed = Date.now() - prov.openedAt;
            if (elapsed >= this.config.providerRecoveryDelayMs) {
                prov.state = 'half_open';
                prov.lastProbeAt = Date.now();
                console.log(
                    `[CircuitBreaker] Provider ${providerId}: OPEN → HALF_OPEN (recovery probe)`
                );
                return true;
            }
        }

        return false;
    }

    /**
     * Get the current state of a provider's circuit breaker.
     */
    getProviderState(providerId: string): BreakerState {
        return this.providers.get(providerId)?.state ?? 'closed';
    }

    private evaluateProviderHealth(prov: ProviderState): void {
        const calls = prov.calls;

        if (calls.length < this.config.providerMinSamples) return;

        const failures = calls.filter((c) => !c.success).length;
        const errorRate = failures / calls.length;

        // Check latency (p99)
        const sortedLatencies = calls
            .map((c) => c.latencyMs)
            .sort((a, b) => a - b);
        const p99Index = Math.floor(sortedLatencies.length * 0.99);
        const p99Latency = sortedLatencies[p99Index] ?? 0;

        const isUnhealthy =
            errorRate >= this.config.providerErrorRateThreshold ||
            p99Latency >= this.config.providerLatencyThresholdMs;

        if (prov.state === 'half_open') {
            // Check the most recent call (the probe)
            const lastCall = calls[calls.length - 1];
            if (lastCall?.success) {
                prov.state = 'closed';
                prov.openedAt = null;
                console.log(
                    `[CircuitBreaker] Provider ${prov.providerId}: HALF_OPEN → CLOSED (probe succeeded)`
                );
            } else {
                prov.state = 'open';
                prov.openedAt = Date.now();
                console.log(
                    `[CircuitBreaker] Provider ${prov.providerId}: HALF_OPEN → OPEN (probe failed)`
                );
            }
            return;
        }

        if (prov.state === 'closed' && isUnhealthy) {
            prov.state = 'open';
            prov.openedAt = Date.now();
            console.log(
                `[CircuitBreaker] Provider ${prov.providerId}: CLOSED → OPEN ` +
                `(errorRate: ${(errorRate * 100).toFixed(0)}%, p99: ${p99Latency}ms)`
            );
        }
    }

    // ============================================================
    // Helpers
    // ============================================================

    private createTripEvent(
        taskId: string,
        reason: TripReason,
        severity: 'soft' | 'hard',
        iteration: number,
        message: string,
        details?: Record<string, unknown>,
    ): TripEvent {
        return {
            taskId,
            reason,
            severity,
            iteration,
            message,
            timestamp: new Date().toISOString(),
            details,
        };
    }

    /**
     * Reset all state — useful for testing.
     */
    reset(): void {
        this.tasks.clear();
        this.providers.clear();
    }

    /**
     * Get all trip events across all tasks (for telemetry/audit).
     */
    getAllTripEvents(): TripEvent[] {
        const events: TripEvent[] = [];
        for (const state of this.tasks.values()) {
            events.push(...state.tripEvents);
        }
        return events;
    }
}
