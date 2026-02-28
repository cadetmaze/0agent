/**
 * CapabilityAdapter Interface — implement this to add new tools.
 *
 * Every adapter exposes a manifest describing its capabilities,
 * input/output schemas, credential requirements, and side effects.
 * The registry auto-discovers adapters and validates manifests.
 */

import type { InjectedCredentials } from './key-proxy.js';

// ============================================================
// JSON Schema (simplified for scaffold)
// ============================================================

/** Simplified JSON Schema type — replace with full JSON Schema in production */
export interface JSONSchema {
    type: 'object' | 'string' | 'number' | 'boolean' | 'array';
    properties?: Record<string, JSONSchema>;
    required?: string[];
    items?: JSONSchema;
    description?: string;
}

// ============================================================
// Capability Manifest
// ============================================================

export interface CapabilityManifest {
    /** Unique identifier for this adapter */
    id: string;
    /** Human-readable name */
    name: string;
    /** Description of what this adapter does */
    description: string;
    /** Semantic version */
    version: string;
    /** Schema for the input this adapter accepts */
    inputSchema: JSONSchema;
    /** Schema for the output this adapter produces */
    outputSchema: JSONSchema;
    /** Credential IDs this adapter needs (loaded via Key Proxy) */
    requiresCredentials: string[];
    /** Whether this adapter has side effects */
    sideEffects: 'none' | 'reversible' | 'irreversible';
    /** Estimated cost per call in dollars (optional) */
    estimatedCostPerCall?: number;
}

// ============================================================
// Adapter Input / Output
// ============================================================

/**
 * Validated input — the registry validates against the manifest's inputSchema
 * before passing to execute().
 */
export interface ValidatedInput {
    /** The validated payload */
    data: Record<string, unknown>;
    /** Validation timestamp */
    validatedAt: string;
    /** Whether the input passed schema validation */
    valid: true;
}

/**
 * Result from adapter execution.
 */
export interface AdapterResult {
    /** Whether the execution succeeded */
    success: boolean;
    /** The output data — must match manifest's outputSchema */
    data: Record<string, unknown>;
    /** Execution metadata */
    metadata: {
        durationMs: number;
        adapterId: string;
        timestamp: string;
    };
    /** Error details if success is false */
    error?: string;
}

/**
 * Error from adapter execution.
 */
export interface AdapterError {
    code: string;
    message: string;
    retriable: boolean;
    adapterId: string;
}

/**
 * Context returned by errorContext() to help the agent decide retry vs escalate.
 */
export interface ErrorContext {
    error: AdapterError;
    suggestedAction: 'retry' | 'escalate' | 'abort';
    retryDelayMs?: number;
    maxRetries?: number;
    humanReadableExplanation: string;
}

/**
 * Health status for an adapter.
 */
export interface HealthStatus {
    healthy: boolean;
    adapterId: string;
    lastChecked: string;
    details?: string;
}

// ============================================================
// CapabilityAdapter Interface
// ============================================================

export interface CapabilityAdapter {
    /**
     * Returns the manifest describing this adapter's capabilities.
     */
    manifest(): CapabilityManifest;

    /**
     * Execute the adapter's primary function.
     * Input is validated against the manifest's inputSchema before this is called.
     * Credentials come from the Key Proxy — never raw strings.
     */
    execute(
        input: ValidatedInput,
        credentials: InjectedCredentials
    ): Promise<AdapterResult>;

    /**
     * Health check — returns whether the adapter is operational.
     */
    health(): Promise<HealthStatus>;

    /**
     * Called when execute fails — returns context for the agent to decide retry vs escalate.
     */
    errorContext(error: AdapterError): ErrorContext;
}
