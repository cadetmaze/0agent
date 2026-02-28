/**
 * APIServer — CLI and API interaction layer.
 *
 * Implements the REST endpoints and WebSocket tasks required by the
 * 0agent CLI. Uses Express for HTTP and 'ws' for streaming tasks.
 */

import express, { type Request, type Response } from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer, Server as HttpServer } from 'http';
import type { Agent } from './agent.js';
import type { TaskDefinition, SecurityContext } from './core/envelope.js';
import IORedis from 'ioredis';

// ============================================================
// Types
// ============================================================

interface WSMessage {
    type: 'task' | 'approve' | 'decline';
    payload?: {
        task: string;
        agent?: string;
    };
    taskId?: string;
}

// ============================================================
// Server Implementation
// ============================================================

export class APIServer {
    private app: express.Application;
    private httpServer: HttpServer;
    private wss: WebSocketServer;
    private redisSub: IORedis;

    constructor(private readonly agent: Agent) {
        this.app = express();
        this.app.use(express.json());
        this.httpServer = createServer(this.app);
        this.wss = new WebSocketServer({ server: this.httpServer, path: '/ws' });

        // Separate Redis connection for Pub/Sub subscriptions
        this.redisSub = new IORedis({
            host: process.env['REDIS_HOST'] ?? 'redis',
            port: parseInt(process.env['REDIS_PORT'] ?? '6379', 10),
            password: process.env['REDIS_PASSWORD'] || undefined,
        });

        this.setupRoutes();
        this.setupWebSocket();
    }

    /**
     * Start the server on the specified port.
     */
    async start(port: number): Promise<void> {
        return new Promise((resolve) => {
            this.httpServer.listen(port, () => {
                resolve();
            });
        });
    }

    /**
     * Stop the server gracefully.
     */
    async stop(): Promise<void> {
        this.wss.close();
        this.redisSub.disconnect();
        return new Promise((resolve) => {
            this.httpServer.close(() => resolve());
        });
    }

    // ============================================================
    // Private: Routes
    // ============================================================

    private setupRoutes(): void {
        this.app.get('/health', (_req: Request, res: Response) => res.json({ status: 'ok' }));

        // --- Status ---
        this.app.get('/api/status', async (_req: Request, res: Response) => {
            const orchestrator = this.agent.getOrchestrator();
            // TODO: Extract actual uptime and usage stats
            res.json({
                running: true,
                model: process.env['DEFAULT_MODEL'] ?? 'claude-sonnet-4-5',
                uptime: '1h 30m',
                activeTasks: [], // TODO: get from orchestrator queue
                haltedTasks: [],
                usage: { tokens: 0, cost: 0 }
            });
        });

        // --- Stop/Resume ---
        this.app.post('/api/stop', (_req: Request, res: Response) => {
            res.json({ message: 'Stopping agent...' });
            void this.agent.shutdown().then(() => process.exit(0));
        });

        this.app.post('/api/tasks/:id/stop', async (req: Request, res: Response) => {
            const id = req.params['id']!;
            const { force } = req.body as { force?: boolean };
            await this.agent.getOrchestrator().getInterruptStore().halt(id, 'user', force ? 'force' : undefined);
            res.json({ status: 'halted' });
        });

        this.app.post('/api/tasks/:id/resume', async (req: Request, res: Response) => {
            const id = req.params['id']!;
            await this.agent.getOrchestrator().getInterruptStore().resume(id);
            res.json({ status: 'resumed' });
        });

        // --- Skills ---
        this.app.get('/api/skills', async (_req: Request, res: Response) => {
            const skills = await this.agent.getSkillRegistry().list();
            res.json(skills);
        });

        this.app.post('/api/skills/install', async (req: Request, res: Response) => {
            const { source, name } = req.body as { source: string; name?: string };
            try {
                const skill = await this.agent.getSkillRegistry().install(source, name);
                res.json(skill);
            } catch (err) {
                res.status(400).json({ error: (err as Error).message });
            }
        });

        this.app.post('/api/skills/:name/enable', async (req: Request, res: Response) => {
            await this.agent.getSkillRegistry().enable(req.params['name']!);
            res.json({ status: 'enabled' });
        });

        this.app.post('/api/skills/:name/disable', async (req: Request, res: Response) => {
            await this.agent.getSkillRegistry().disable(req.params['name']!);
            res.json({ status: 'disabled' });
        });

        this.app.delete('/api/skills/:name', async (req: Request, res: Response) => {
            try {
                await this.agent.getSkillRegistry().disable(req.params['name']!);
                res.json({ status: 'disabled' });
            } catch {
                res.status(400).json({ error: 'Cannot remove built-in skills' });
            }
        });

        // --- Memory ---
        this.app.get('/api/memory', async (req: Request, res: Response) => {
            const query = req.query['q'] as string;
            const type = req.query['type'] as string;
            const limit = parseInt(req.query['limit'] as string || '10', 10);

            const { data } = await this.agent.getSupabase()
                .from('memory_nodes')
                .select('*')
                .eq('company_id', this.agent.getCompanyId())
                .order('created_at', { ascending: false })
                .limit(limit);

            res.json(data ?? []);
        });

        // --- Logs ---
        this.app.get('/api/logs', async (req: Request, res: Response) => {
            const limit = parseInt(req.query['lines'] as string || '50', 10);
            const { data } = await this.agent.getSupabase()
                .from('logs')
                .select('*')
                .eq('agent_id', this.agent.getAgentId())
                .order('created_at', { ascending: false })
                .limit(limit);
            res.json((data ?? []).reverse());
        });

        this.app.get('/api/logs/stream', (req: Request, res: Response) => {
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.flushHeaders();

            // Simple poll for now — in production use Supabase Realtime or Redis Pub/Sub
            const interval = setInterval(async () => {
                const { data } = await this.agent.getSupabase()
                    .from('logs')
                    .select('*')
                    .eq('agent_id', this.agent.getAgentId())
                    .order('created_at', { ascending: false })
                    .limit(1)
                    .single();

                if (data) {
                    res.write(`data: ${JSON.stringify({
                        level: data.level,
                        ts: data.created_at,
                        msg: data.message,
                        taskId: data.task_id
                    })}\n\n`);
                }
            }, 2000);

            req.on('close', () => clearInterval(interval));
        });
    }

    // ============================================================
    // Private: WebSocket
    // ============================================================

    private setupWebSocket(): void {
        this.wss.on('connection', (ws: WebSocket) => {
            console.log('[APIServer] New WebSocket connection');

            ws.on('message', async (data) => {
                try {
                    const msg = JSON.parse(data.toString()) as WSMessage;

                    if (msg.type === 'task' && msg.payload) {
                        await this.handleTaskSubmission(ws, msg.payload.task);
                    } else if (msg.type === 'approve' && msg.taskId) {
                        // Resumes a task that was stuck at Approval Gate
                        await this.agent.getOrchestrator().getInterruptStore().resume(msg.taskId);
                    }
                } catch (err) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Malformed message' }));
                }
            });
        });
    }

    private async handleTaskSubmission(ws: WebSocket, taskSpec: string): Promise<void> {
        const orchestrator = this.agent.getOrchestrator();

        // 1. Create task definition
        const task: TaskDefinition = {
            spec: taskSpec,
            acceptanceCriteria: [],
            dependencies: [],
            estimatedCostTokens: 0,
            estimatedCostDollars: 0,
            outcomePointer: 'result',
        };

        // 2. Build DAG and schedule
        const security: SecurityContext = {
            allowedAdapters: [],
            maxSpendDollars: 1.0,
            requiresApproval: false,
        };

        const graph = orchestrator.buildDAG([{ task, security }]);
        const rootId = graph.rootNodes[0];
        if (!rootId) return;

        // 3. Subscribe to events via Redis Pub/Sub
        const channel = `task-events:${rootId}`;
        await this.redisSub.subscribe(channel);

        const eventHandler = (chan: string, message: string) => {
            if (chan === channel) {
                ws.send(message);
                const msg = JSON.parse(message) as { type: string };
                if (msg.type === 'done' || msg.type === 'error') {
                    this.redisSub.unsubscribe(channel).catch(() => { });
                }
            }
        };

        this.redisSub.on('message', eventHandler);

        // 4. Start execution
        await orchestrator.scheduleReadyTasks(this.agent.getAgentId(), this.agent.getCompanyId());

        ws.on('close', () => {
            this.redisSub.unsubscribe(channel).catch(() => { });
            this.redisSub.off('message', eventHandler);
        });
    }
}
