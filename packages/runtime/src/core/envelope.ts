/**
 * TaskEnvelope — The central data structure of the Only Reason 0 Agent.
 *
 * Every task flows through this envelope. It carries expert judgment,
 * org context, task definition, and security constraints. Nothing
 * executes without a fully populated envelope.
 *
 * The Python judgment service must produce JSON that maps exactly
 * to the ExpertJudgment and OrgContext shapes defined here.
 */

// ============================================================
// Instruction Source Tags — used for prompt injection defense
// ============================================================

/**
 * Every instruction reaching the LLM is tagged with its origin.
 * - system: from core memory and policy engine (highest trust)
 * - founder: from approved human input
 * - task: from orchestrator
 * - external: from tool outputs — NEVER treated as commands
 */
export type InstructionSource = 'system' | 'founder' | 'task' | 'external';

/**
 * All messages to the LLM carry their source tag.
 * The LLM router enforces that 'external' content cannot issue instructions.
 */
export interface TaggedMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
    source: InstructionSource;
}

// ============================================================
// Sanitized Input — structural prompt injection defense
// ============================================================

/**
 * Wraps all external content in a typed object.
 * The agent never receives raw strings from external sources.
 * The LLM router accepts SanitizedInput, not string, for external content.
 */
export interface SanitizedInput {
    /** The sanitized content string */
    content: string;
    /** Original source of the content */
    sourceType: 'web_scrape' | 'email' | 'api_response' | 'user_message' | 'tool_output';
    /** ISO timestamp when the content was sanitized */
    sanitizedAt: string;
    /** Whether any potentially dangerous patterns were detected and neutralized */
    hadSuspiciousPatterns: boolean;
    /** Description of patterns found, if any */
    suspiciousPatternDetails?: string[];
}

// ============================================================
// Expert Judgment Sub-Types
// ============================================================

/** A domain-specific pattern the expert recognizes and knows how to handle */
export interface JudgmentPattern {
    /** Unique identifier for this pattern */
    id: string;
    /** Human-readable name */
    name: string;
    /** Description of when this pattern applies */
    description: string;
    /** The expert's recommended response to this pattern */
    responseGuidance: string;
    /** Domains where this pattern is relevant */
    domains: string[];
    /** How confident the expert is in this pattern (0-1) */
    confidence: number;
}

/** A trigger condition that should cause the agent to escalate to a human */
export interface Trigger {
    /** Unique identifier */
    id: string;
    /** Human-readable description of the trigger */
    description: string;
    /** Keywords or patterns that activate this trigger */
    patterns: string[];
    /** What to do when triggered */
    action: 'escalate' | 'pause' | 'abort';
    /** Priority: higher = more urgent */
    priority: number;
}

/** A hard constraint the agent must NEVER violate */
export interface Constraint {
    /** Unique identifier */
    id: string;
    /** Human-readable description of the constraint */
    description: string;
    /** The rule expressed as a negative — what the agent must NOT do */
    rule: string;
    /** Category for grouping */
    category: 'security' | 'compliance' | 'brand' | 'operational' | 'legal';
    /** If true, violation of this constraint is an immediate abort */
    critical: boolean;
}

/** Defines when the agent should act autonomously vs slow down vs escalate */
export interface ConfidenceRange {
    /** Minimum confidence score for this range (inclusive) */
    min: number;
    /** Maximum confidence score for this range (inclusive) */
    max: number;
    /** What the agent should do in this range */
    action: 'act' | 'slow_down' | 'escalate';
    /** Additional notes about this range */
    description: string;
}

// ============================================================
// Org Context Sub-Types
// ============================================================

/** An active decision being made by the organization */
export interface Decision {
    id: string;
    title: string;
    description: string;
    status: 'proposed' | 'in_progress' | 'decided' | 'deferred';
    stakeholders: string[];
    deadline?: string;
    /** Who made this decision (agent UUID or human UUID) */
    madeBy?: string;
    /** Whether made by an agent or human */
    madeByType?: 'agent' | 'human';
    /** Recorded outcome, if resolved */
    outcome?: string;
    /** Tags for categorization and search */
    tags?: string[];
}

/** A key person in the organization */
export interface Person {
    id: string;
    name: string;
    role: string;
    relevance: string;
    contactPreference?: string;
}

/** A relevant event from a past session */
export interface EpisodicEvent {
    sessionId: string;
    summary: string;
    outcome: string;
    timestamp: string;
    sentiment: number;
    relevanceScore: number;
}

// ============================================================
// Expert Judgment — loaded from Core Memory via Python service
// ============================================================

export interface ExpertJudgment {
    /** Expert who trained this judgment */
    expertId: string;
    /** Hash of the training session that produced this judgment */
    version: string;
    /** Domain pattern recognition */
    patterns: JudgmentPattern[];
    /** When to stop and call a human */
    escalationTriggers: Trigger[];
    /** Things this agent will NEVER do */
    hardConstraints: Constraint[];
    /** When to act vs slow down vs escalate */
    confidenceMap: ConfidenceRange[];
}

// ============================================================
// Org Context — loaded from org knowledge graph
// ============================================================

/** Persistent company-scoped context — survives agent swaps */
export interface ActiveContextSnapshot {
    priorities: string[];
    openQuestions: Array<{ question: string; raisedBy: string; priority: number }>;
    activeExperiments: Array<{ name: string; hypothesis: string; status: string }>;
}

/** Company optimization mode — affects model selection and capability routing */
export type OptimizationMode = 'quality' | 'cost' | 'balanced' | 'speed';

export interface OrgContext {
    /** Current organizational goal */
    goal: string;
    /** Active decisions being made */
    activeDecisions: Decision[];
    /** Key people to be aware of */
    keyPeople: Person[];
    /** Remaining budget in dollars */
    budgetRemaining: number;
    /** Organizational constraints */
    constraints: string[];
    /** Relevant past sessions */
    history: EpisodicEvent[];
    /** Persistent active context — priorities, open questions, experiments */
    activeContext?: ActiveContextSnapshot;
    /** Company optimization mode */
    optimizationMode?: OptimizationMode;
}

// ============================================================
// Task Definition
// ============================================================

export interface TaskDefinition {
    /** What to do, in plain language */
    spec: string;
    /** Measurable criteria for task completion */
    acceptanceCriteria: string[];
    /** Estimated cost in tokens */
    estimatedCostTokens: number;
    /** Estimated cost in dollars */
    estimatedCostDollars: number;
    /** Task IDs this task depends on */
    dependencies: string[];
    /** KPI this task contributes to — used for APL measurement */
    outcomePointer: string;
}

// ============================================================
// Security Context — populated by policy engine only
// ============================================================

export interface SecurityContext {
    /** Capability adapter IDs this task is allowed to use */
    allowedAdapters: string[];
    /** Maximum spend in dollars for this task */
    maxSpendDollars: number;
    /** Whether this task requires human approval before execution */
    requiresApproval: boolean;
    /** Reason approval is required, if applicable */
    approvalReason?: string;
}

// ============================================================
// The Task Envelope — central data structure
// ============================================================

export interface TaskEnvelope {
    // --- Identity ---
    /** Unique ID for this task instance */
    taskId: string;
    /** ID of the agent executing this task */
    agentId: string;
    /** ID of the company this task belongs to */
    companyId: string;
    /** ID of the seat this agent holds (if assigned) */
    seatId?: string;
    /** ID of the expert whose judgment is loaded */
    expertId?: string;

    // --- Expert Judgment ---
    expertJudgment: ExpertJudgment;

    // --- Org Context ---
    orgContext: OrgContext;

    // --- Task Definition ---
    task: TaskDefinition;

    // --- Security ---
    security: SecurityContext;

    // --- Optimization ---
    /** Company optimization mode — influences model selection and capability routing */
    optimizationMode: OptimizationMode;
}

// ============================================================
// Utility Types
// ============================================================

/** Result of applying the expert judgment lens to LLM output */
export interface LensedResult {
    /** The original output from the LLM */
    output: string;
    /** Whether a hard constraint was violated */
    constraintViolation: boolean;
    /** Details of the violation, if any */
    violationDetails?: string;
    /** Whether the output needs human review */
    requiresReview: boolean;
    /** Whether an escalation trigger was matched */
    escalate: boolean;
    /** Reason for escalation */
    escalationReason?: string;
    /** Confidence score of the output */
    confidenceScore: number;
}

/** Result from an LLM completion call */
export interface CompletionResult {
    /** The generated text */
    content: string;
    /** Model that generated it */
    model: string;
    /** Provider that served it */
    provider: string;
    /** Tokens used for input */
    inputTokens: number;
    /** Tokens used for output */
    outputTokens: number;
    /** Cost in dollars */
    costDollars: number;
    /** Latency in milliseconds */
    latencyMs: number;
    /** Stop reason */
    stopReason: 'end_turn' | 'max_tokens' | 'stop_sequence';
}

/** Cost estimate before making an LLM call */
export interface CostEstimate {
    estimatedInputTokens: number;
    estimatedOutputTokens: number;
    estimatedCostDollars: number;
    provider: string;
    model: string;
}

/** Options for LLM completion */
export interface CompletionOptions {
    maxTokens: number;
    temperature: number;
    stopSequences?: string[];
    /** Task type classification — influences model selection */
    taskType: TaskClassification;
}

/** Task classification for LLM routing */
export type TaskClassification =
    | 'judgment_heavy'   // Requires deep reasoning — route to strongest model
    | 'standard'         // Normal tasks — balanced model
    | 'fast'             // Quick lookups/formatting — cheapest model
    | 'sensitive';       // Contains PII or confidential data — local model only

/** Classified task for provider selection */
export interface ClassifiedTask {
    classification: TaskClassification;
    estimatedComplexity: number;
    requiresLocalOnly: boolean;
    spec: string;
}

/** Provider health status */
export interface ProviderHealth {
    available: boolean;
    latencyMs: number;
    errorRate: number;
    lastChecked: string;
}
