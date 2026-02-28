/**
 * SandboxAdapter — Execution sandbox stub.
 *
 * Provides a sandboxed environment for running code snippets.
 * In production, this would use Docker containers, Firecracker, or similar.
 */

import type {
    CapabilityAdapter,
    CapabilityManifest,
    ValidatedInput,
    AdapterResult,
    AdapterError,
    ErrorContext,
    HealthStatus,
} from './base.js';
import type { InjectedCredentials } from './key-proxy.js';

export class SandboxAdapter implements CapabilityAdapter {
    manifest(): CapabilityManifest {
        return {
            id: 'sandbox',
            name: 'Code Sandbox',
            description: 'Execute code snippets in a sandboxed environment',
            version: '0.1.0',
            inputSchema: {
                type: 'object',
                properties: {
                    language: { type: 'string', description: 'Programming language (python, javascript, bash)' },
                    code: { type: 'string', description: 'Code to execute' },
                    timeoutMs: { type: 'number', description: 'Execution timeout in milliseconds' },
                },
                required: ['language', 'code'],
            },
            outputSchema: {
                type: 'object',
                properties: {
                    stdout: { type: 'string' },
                    stderr: { type: 'string' },
                    exitCode: { type: 'number' },
                    executionTimeMs: { type: 'number' },
                },
            },
            requiresCredentials: [],
            sideEffects: 'none',
        };
    }

    async execute(
        input: ValidatedInput,
        _credentials: InjectedCredentials
    ): Promise<AdapterResult> {
        const startTime = Date.now();

        // TODO: Implement actual sandboxed execution using Docker/Firecracker.
        console.log(`[SandboxAdapter] Executing ${input.data['language']} code (stub)`);

        return {
            success: true,
            data: {
                stdout: `[STUB] Would execute ${input.data['language']} code in sandbox`,
                stderr: '',
                exitCode: 0,
                executionTimeMs: Date.now() - startTime,
            },
            metadata: {
                durationMs: Date.now() - startTime,
                adapterId: 'sandbox',
                timestamp: new Date().toISOString(),
            },
        };
    }

    async health(): Promise<HealthStatus> {
        return {
            healthy: true,
            adapterId: 'sandbox',
            lastChecked: new Date().toISOString(),
            details: 'Stub adapter — always healthy',
        };
    }

    errorContext(error: AdapterError): ErrorContext {
        return {
            error,
            suggestedAction: 'retry',
            retryDelayMs: 1000,
            maxRetries: 3,
            humanReadableExplanation: `Sandbox execution failed: ${error.message}`,
        };
    }
}
