/**
 * BrowserAdapter — Playwright browser automation stub.
 *
 * In production, this uses Playwright to navigate pages, scrape content,
 * fill forms, and capture screenshots.
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

export class BrowserAdapter implements CapabilityAdapter {
    manifest(): CapabilityManifest {
        return {
            id: 'browser',
            name: 'Browser Automation',
            description: 'Navigate web pages, scrape content, fill forms, and capture screenshots via Playwright',
            version: '0.1.0',
            inputSchema: {
                type: 'object',
                properties: {
                    action: { type: 'string', description: 'Action: navigate | scrape | screenshot | fill_form | click' },
                    url: { type: 'string', description: 'Target URL' },
                    selector: { type: 'string', description: 'CSS selector for interaction' },
                    value: { type: 'string', description: 'Value for fill_form action' },
                },
                required: ['action', 'url'],
            },
            outputSchema: {
                type: 'object',
                properties: {
                    content: { type: 'string' },
                    screenshotBase64: { type: 'string' },
                    statusCode: { type: 'number' },
                    title: { type: 'string' },
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

        // TODO: Implement Playwright browser automation.
        // Install playwright: npm install playwright
        // Use a browser pool for concurrent requests.
        console.log(
            `[BrowserAdapter] ${input.data['action']} on ${input.data['url']} (stub)`
        );

        return {
            success: true,
            data: {
                content: `[STUB] Would ${input.data['action']} on ${input.data['url']}`,
                screenshotBase64: '',
                statusCode: 200,
                title: 'Stub Page Title',
            },
            metadata: {
                durationMs: Date.now() - startTime,
                adapterId: 'browser',
                timestamp: new Date().toISOString(),
            },
        };
    }

    async health(): Promise<HealthStatus> {
        // TODO: Check that Playwright browsers are installed.
        return {
            healthy: true,
            adapterId: 'browser',
            lastChecked: new Date().toISOString(),
            details: 'Stub adapter — always healthy',
        };
    }

    errorContext(error: AdapterError): ErrorContext {
        return {
            error,
            suggestedAction: error.retriable ? 'retry' : 'escalate',
            retryDelayMs: 2000,
            maxRetries: 2,
            humanReadableExplanation: `Browser automation failed: ${error.message}`,
        };
    }
}
