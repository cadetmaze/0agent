/**
 * 0agent task — Submit a task and stream output live via WebSocket.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import WebSocket from 'ws';
import { createInterface } from 'readline';

interface AgentMessage {
    type: 'stream' | 'tool_call' | 'done' | 'error' | 'approval_needed';
    chunk?: string;
    tool?: string;
    description?: string;
    cost?: number;
    tokens?: number;
    message?: string;
    taskId?: string;
    action?: string;
    context?: string;
}

export const taskCommand = new Command('task')
    .description('Give the agent a task and stream output live')
    .argument('<task>', 'What you want the agent to do')
    .option('--agent <name>', 'Which agent to use', 'default')
    .option('--no-stream', 'Wait for completion instead of streaming')
    .action(async (task: string, options: { agent: string; stream: boolean }) => {
        console.log(chalk.cyan(`\n  → ${task}\n`));

        const spinner = ora('Connecting to agent...').start();

        const ws = new WebSocket('ws://localhost:3000/ws');

        ws.on('open', () => {
            spinner.stop();
            ws.send(JSON.stringify({
                type: 'task',
                payload: { task, agent: options.agent },
            }));
        });

        ws.on('message', (data) => {
            const msg = JSON.parse(data.toString()) as AgentMessage;

            switch (msg.type) {
                case 'stream':
                    if (msg.chunk) process.stdout.write(msg.chunk);
                    break;

                case 'tool_call':
                    console.log(chalk.gray(`\n  [${msg.tool ?? 'tool'}] ${msg.description ?? ''}`));
                    break;

                case 'done':
                    console.log(chalk.green('\n\n  ✓ Done'));
                    if (msg.cost !== undefined) {
                        console.log(chalk.gray(`  Cost: $${msg.cost.toFixed(4)} | Tokens: ${msg.tokens ?? 0}`));
                    }
                    ws.close();
                    process.exit(0);
                    break;

                case 'approval_needed':
                    console.log(chalk.yellow(`\n\n  ⚠ Approval needed: ${msg.action ?? ''}`));
                    console.log(chalk.gray(`  ${msg.context ?? ''}\n`));
                    void promptApproval(ws, msg.taskId ?? '');
                    break;

                case 'error':
                    console.log(chalk.red(`\n  ✗ ${msg.message ?? 'Unknown error'}`));
                    ws.close();
                    process.exit(1);
                    break;
            }
        });

        ws.on('error', () => {
            spinner.fail('Could not connect. Is the agent running? Try: 0agent start');
            process.exit(1);
        });
    });

async function promptApproval(ws: WebSocket, taskId: string): Promise<void> {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(chalk.cyan('  Approve? [y/n] '), (answer) => {
        rl.close();
        ws.send(JSON.stringify({
            type: answer.toLowerCase() === 'y' ? 'approve' : 'decline',
            taskId,
        }));
    });
}
