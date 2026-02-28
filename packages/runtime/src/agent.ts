/**
 * Agent — Main agent process. Boots, runs, heartbeats.
 *
 * Boot sequence (strict order):
 * 1. Load environment variables — fail fast if missing
 * 2. Connect to Supabase — verify connection
 * 3. Load Core Memory for this agent ID
 * 4. Lock hard constraints in policy engine
 * 5. Verify Python judgment service health
 * 6. Initialize Key Proxy — load and decrypt credentials
 * 7. Initialize adapter registry — discover and validate
 * 8. Initialize BullMQ worker — connect to Redis
 * 9. Start heartbeat loop — write liveness every 30s
 * 10. Start task processing loop
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import IORedis from 'ioredis';
import type { Constraint, Trigger, ConfidenceRange } from './core/envelope.js';
import { PolicyEngine } from './core/policy-engine.js';
import { BudgetEngine } from './core/budget-engine.js';
import { ApprovalGate } from './core/approval-gate.js';
import { KeyProxy } from './adapters/key-proxy.js';
import { AdapterRegistry } from './adapters/registry.js';
import { LLMRouter } from './router/llm-router.js';
import { AnthropicProvider } from './router/providers/anthropic.js';
import { OpenAIProvider } from './router/providers/openai.js';
import { LocalProvider } from './router/providers/local.js';
import { Orchestrator } from './core/orchestrator.js';
import { MemoryManager } from './memory/memory-manager.js';
import { Logger } from './telemetry/logger.js';
import { SkillRegistry } from './skills/skill-registry.js';
import { SkillLoader } from './skills/skill-loader.js';
import { APIServer } from './server.js';
import { join } from 'path';

// ============================================================
// Required environment variables
// ============================================================

const REQUIRED_ENV_VARS = [
    'DATABASE_URL',
    'SUPABASE_URL',
    'SUPABASE_SERVICE_KEY',
    'REDIS_HOST',
    'CREDENTIAL_ENCRYPTION_KEY',
    'SERVICE_TOKEN',
    'AGENT_ID',
    'COMPANY_ID',
] as const;

// ============================================================
// Agent Class
// ============================================================

export class Agent {
    private supabase!: SupabaseClient;
    private redis!: IORedis;
    private policyEngine!: PolicyEngine;
    private budgetEngine!: BudgetEngine;
    private approvalGate!: ApprovalGate;
    private keyProxy!: KeyProxy;
    private adapterRegistry!: AdapterRegistry;
    private router!: LLMRouter;
    private orchestrator!: Orchestrator;
    private memoryManager!: MemoryManager;
    private logger!: Logger;
    private skillRegistry!: SkillRegistry;
    private skillLoader!: SkillLoader;
    private server!: APIServer;

    private agentId!: string;
    private companyId!: string;
    private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    private running = false;

    /**
     * Boot the agent. Executes all 10 steps in strict order.
     * If any step fails, logs the error and exits with code 1.
     */
    async boot(): Promise<void> {
        try {
            // Step 1: Load environment variables
            this.logStep(1, 'Loading environment variables');
            const env = this.loadEnv();
            this.agentId = env.AGENT_ID!;
            this.companyId = env.COMPANY_ID!;
            this.logStep(1, 'Environment variables loaded ✓');

            // Step 2: Connect to Supabase
            this.logStep(2, 'Connecting to Supabase');
            this.supabase = createClient(env.SUPABASE_URL!, env.SUPABASE_SERVICE_KEY!);
            await this.verifySupabaseConnection();
            this.logStep(2, 'Supabase connected ✓');

            // Step 3: Load Core Memory + Active Context + Verify Seat
            this.logStep(3, 'Loading Core Memory');
            const coreMemory = await this.loadCoreMemory();
            this.logStep(3, `Core Memory loaded ✓ (version: ${coreMemory.trainingVersion})`);

            // Step 3b: Load Active Context (company-scoped, persistent)
            this.logStep(3, 'Loading Active Context');
            this.memoryManager = new MemoryManager(this.supabase);
            const activeCtx = await this.memoryManager.activeContext.load(this.companyId);
            this.logStep(3, `Active Context loaded ✓ (${activeCtx.priorities.length} priorities, ${activeCtx.inFlightTasks.length} in-flight)`);

            // Step 3c: Verify seat assignment
            this.logStep(3, 'Verifying seat assignment');
            const { data: seatData } = await this.supabase
                .from('seats')
                .select('id, role, status')
                .eq('current_agent_id', this.agentId)
                .single();
            if (seatData) {
                this.logStep(3, `Seat verified ✓ (role: ${seatData.role as string}, status: ${seatData.status as string})`);
            } else {
                this.logStep(3, 'No seat assignment found — agent will operate without a seat');
            }

            // Step 4: Lock hard constraints
            this.logStep(4, 'Locking hard constraints in policy engine');
            this.policyEngine = new PolicyEngine();
            this.policyEngine.boot(
                coreMemory.hardConstraints,
                coreMemory.escalationTriggers,
                coreMemory.confidenceMap
            );
            this.logStep(4, `Hard constraints locked ✓ (${coreMemory.hardConstraints.length} constraints)`);

            // Step 5: Verify Python judgment service
            this.logStep(5, 'Verifying judgment service health');
            await this.verifyJudgmentService(env.SERVICE_TOKEN!);
            this.logStep(5, 'Judgment service healthy ✓');

            // Step 6: Initialize Key Proxy
            this.logStep(6, 'Initializing Key Proxy');
            this.keyProxy = new KeyProxy(env.CREDENTIAL_ENCRYPTION_KEY!);
            const credentials = await this.loadCredentials();
            await this.keyProxy.initialize(credentials);
            this.logStep(6, 'Key Proxy initialized ✓');

            // Step 7: Initialize adapter registry
            this.logStep(7, 'Initializing adapter registry');
            this.adapterRegistry = new AdapterRegistry();
            await this.adapterRegistry.discoverBuiltinAdapters();
            this.adapterRegistry.logAvailableAdapters();
            this.logStep(7, 'Adapter registry initialized ✓');

            // Step 8: Initialize BullMQ and components
            this.logStep(8, 'Connecting to Redis and initializing BullMQ');
            this.redis = new IORedis({
                host: env.REDIS_HOST,
                port: parseInt(env.REDIS_PORT ?? '6379', 10),
                password: env.REDIS_PASSWORD || undefined,
                maxRetriesPerRequest: null,
            });
            await this.verifyRedisConnection();

            this.budgetEngine = new BudgetEngine();
            this.approvalGate = new ApprovalGate(this.supabase);
            // memoryManager already initialized in Step 3b
            this.logger = new Logger(this.supabase, (env.LOG_LEVEL ?? 'info') as 'debug' | 'info' | 'warn' | 'error');
            this.logger.start();

            // Step 7b: Initialize Skill components
            this.logStep(7, 'Initializing skill components');
            const skillsRoot = env.SKILLS_ROOT ?? join(process.cwd(), 'skills');
            this.skillRegistry = new SkillRegistry(skillsRoot, this.supabase);
            await this.skillRegistry.discover();
            this.skillLoader = new SkillLoader(this.skillRegistry);
            this.logStep(7, 'Skill components initialized ✓');

            // Initialize LLM Router with providers
            this.router = new LLMRouter();
            this.router.registerProvider(new AnthropicProvider());
            this.router.registerProvider(new OpenAIProvider());
            this.router.registerProvider(new LocalProvider());
            this.router.addRoutingRule({
                classification: 'judgment_heavy',
                preferredProviderId: 'anthropic',
            });
            this.router.addRoutingRule({
                classification: 'standard',
                preferredProviderId: 'openai',
            });
            this.router.addRoutingRule({
                classification: 'fast',
                preferredProviderId: 'openai',
            });
            this.router.addRoutingRule({
                classification: 'sensitive',
                preferredProviderId: 'local',
            });

            this.orchestrator = new Orchestrator(
                this.supabase,
                this.redis,
                this.policyEngine,
                this.budgetEngine,
                this.approvalGate,
                this.router,
                this.memoryManager,
                this.logger,
                {},
                this.skillLoader
            );
            this.orchestrator.startWorker(this.agentId, this.companyId, this.redis);
            this.logStep(8, 'BullMQ worker started ✓');

            // Step 9: Start heartbeat
            this.logStep(9, 'Starting heartbeat loop');
            const heartbeatInterval = parseInt(
                env.HEARTBEAT_INTERVAL_SECONDS ?? '30',
                10
            ) * 1000;
            this.startHeartbeat(heartbeatInterval);
            this.logStep(9, `Heartbeat started ✓ (every ${heartbeatInterval / 1000}s)`);

            // Step 10: Start task processing loop
            this.logStep(10, 'Starting task processing loop');
            this.running = true;

            // Step 11: Start API server for CLI interaction
            this.logStep(11, 'Starting API server');
            this.server = new APIServer(this);
            const port = parseInt(env.PORT ?? '3000', 10);
            await this.server.start(port);
            this.logStep(11, `API server listening on port ${port} ✓`);

            this.logStep(11, 'Agent fully booted and ready ✓');

            console.log('\n' + '='.repeat(60));
            console.log(`  Only Reason 0 Agent — ONLINE`);
            console.log(`  Agent ID: ${this.agentId}`);
            console.log(`  Company ID: ${this.companyId}`);
            console.log('='.repeat(60) + '\n');

        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            console.error(`\n[FATAL] Agent boot failed: ${message}\n`);
            process.exit(1);
        }
    }

    /**
     * Graceful shutdown.
     */
    async shutdown(): Promise<void> {
        console.log('[Agent] Shutting down...');
        this.running = false;

        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
        }

        await this.orchestrator?.stopWorker();
        await this.logger?.stop();
        this.redis?.disconnect();

        console.log('[Agent] Shutdown complete');
    }

    // ============================================================
    // Boot step helpers
    // ============================================================

    private loadEnv(): Record<string, string> {
        const env: Record<string, string> = {};

        for (const key of REQUIRED_ENV_VARS) {
            const value = process.env[key];
            if (!value) {
                throw new Error(`Missing required environment variable: ${key}`);
            }
            env[key] = value;
        }

        // Optional vars
        env['REDIS_PORT'] = process.env['REDIS_PORT'] ?? '6379';
        env['REDIS_PASSWORD'] = process.env['REDIS_PASSWORD'] ?? '';
        env['LOG_LEVEL'] = process.env['LOG_LEVEL'] ?? 'info';
        env['HEARTBEAT_INTERVAL_SECONDS'] = process.env['HEARTBEAT_INTERVAL_SECONDS'] ?? '30';

        return env;
    }

    private async verifySupabaseConnection(): Promise<void> {
        const { error } = await this.supabase.from('agents').select('id').limit(1);
        if (error) {
            throw new Error(`Supabase connection failed: ${error.message}`);
        }
    }

    private async loadCoreMemory(): Promise<{
        trainingVersion: string;
        hardConstraints: Constraint[];
        escalationTriggers: Trigger[];
        confidenceMap: ConfidenceRange[];
    }> {
        const { data, error } = await this.supabase
            .from('core_memory')
            .select('*')
            .eq('agent_id', this.agentId)
            .order('created_at', { ascending: false })
            .limit(1)
            .single();

        if (error || !data) {
            // For scaffold: return empty defaults if no core memory exists
            console.warn(
                '[Agent] No core memory found — running with empty constraints. ' +
                'Train the agent through the judgment service to populate core memory.'
            );
            return {
                trainingVersion: 'untrained',
                hardConstraints: [],
                escalationTriggers: [],
                confidenceMap: [
                    { min: 0.0, max: 0.3, action: 'escalate', description: 'Low confidence — escalate' },
                    { min: 0.3, max: 0.6, action: 'slow_down', description: 'Medium confidence — proceed with caution' },
                    { min: 0.6, max: 1.0, action: 'act', description: 'High confidence — act autonomously' },
                ],
            };
        }

        return {
            trainingVersion: data.training_version as string,
            hardConstraints: (data.hard_constraints as Constraint[]) ?? [],
            escalationTriggers: (data.escalation_triggers as Trigger[]) ?? [],
            confidenceMap: (data.confidence_map as ConfidenceRange[]) ?? [],
        };
    }

    private async verifyJudgmentService(serviceToken: string): Promise<void> {
        const judgmentUrl = process.env['JUDGMENT_SERVICE_URL'] ?? 'http://judgment:8001';
        try {
            const response = await fetch(`${judgmentUrl}/health`, {
                headers: { 'X-Service-Token': serviceToken },
            });
            if (!response.ok) {
                throw new Error(`Judgment service returned ${response.status}`);
            }
        } catch (error) {
            // Don't fail boot if judgment service is not available yet —
            // it might start up after the runtime in docker-compose.
            const message = error instanceof Error ? error.message : 'Unknown error';
            console.warn(
                `[Agent] Judgment service not available: ${message}. ` +
                'Will retry on first task. Continuing boot...'
            );
        }
    }

    private async loadCredentials(): Promise<
        Array<{ id: string; companyId: string; adapterName: string; encryptedValue: string }>
    > {
        // Note: In production, the credentials table has RLS that requires
        // the key_proxy service role. For the scaffold, we query directly.
        const { data, error } = await this.supabase
            .from('credentials')
            .select('id, company_id, adapter_name, encrypted_value')
            .eq('company_id', this.companyId);

        if (error) {
            console.warn(`[Agent] Failed to load credentials: ${error.message}`);
            return [];
        }

        return (data ?? []).map((row) => ({
            id: row.id as string,
            companyId: row.company_id as string,
            adapterName: row.adapter_name as string,
            encryptedValue: row.encrypted_value as string,
        }));
    }

    private async verifyRedisConnection(): Promise<void> {
        try {
            await this.redis.ping();
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            throw new Error(`Redis connection failed: ${message}`);
        }
    }

    private startHeartbeat(intervalMs: number): void {
        const heartbeat = async (): Promise<void> => {
            try {
                await this.supabase.from('agents').update({
                    status: 'active',
                }).eq('id', this.agentId);
            } catch (error) {
                const message = error instanceof Error ? error.message : 'Unknown error';
                console.error(`[Agent] Heartbeat failed: ${message}`);
            }
        };

        // Immediate first heartbeat
        void heartbeat();
        this.heartbeatTimer = setInterval(() => void heartbeat(), intervalMs);
    }

    private logStep(step: number, message: string): void {
        const timestamp = new Date().toISOString();
        console.log(`${timestamp} [Boot ${step}/11] ${message}`);
    }

    // ============================================================
    // Getters for API Server
    // ============================================================

    getAgentId(): string { return this.agentId; }
    getCompanyId(): string { return this.companyId; }
    getOrchestrator(): Orchestrator { return this.orchestrator; }
    getSkillRegistry(): SkillRegistry { return this.skillRegistry; }
    getMemoryManager(): MemoryManager { return this.memoryManager; }
    getLogger(): Logger { return this.logger; }
    getSupabase(): SupabaseClient { return this.supabase; }
}
