/**
 * 0agent status — Show what the agent is currently doing.
 */

import { Command } from 'commander';
import chalk from 'chalk';

interface TaskStatus {
    id: string;
    description: string;
    currentStep: string;
    elapsed: number;
    status: 'running' | 'paused' | 'halted_for_approval';
}

interface StatusResponse {
    running: boolean;
    model: string;
    uptime: string;
    activeTasks: TaskStatus[];
    haltedTasks: TaskStatus[];
    usage: {
        tokens: number;
        cost: number;
    };
}

export const statusCommand = new Command('status')
    .description('Show active tasks, usage, and agent health')
    .option('--json', 'Output raw JSON')
    .action(async (options: { json?: boolean }) => {
        try {
            const res = await fetch('http://localhost:3000/api/status', {
                signal: AbortSignal.timeout(5000),
            });

            if (!res.ok) {
                console.log(chalk.yellow('\n  Agent returned an error. Try: 0agent logs\n'));
                return;
            }

            const data = await res.json() as StatusResponse;

            if (options.json) {
                console.log(JSON.stringify(data, null, 2));
                return;
            }

            console.log(chalk.cyan('\n  0agent status\n'));
            console.log(`  Running: ${data.running ? chalk.green('yes') : chalk.red('no')}`);
            console.log(`  Model:   ${chalk.gray(data.model)}`);
            console.log(`  Uptime:  ${chalk.gray(data.uptime)}`);

            if (data.activeTasks?.length > 0) {
                console.log(chalk.cyan('\n  Active tasks:'));
                for (const task of data.activeTasks) {
                    console.log(`    ${chalk.yellow('▶')} [${task.id.slice(0, 8)}] ${task.description}`);
                    console.log(chalk.gray(`      ${task.currentStep} — ${task.elapsed}s elapsed`));
                    console.log(chalk.gray(`      Stop: 0agent stop --task ${task.id}`));
                }
            }

            if (data.haltedTasks?.length > 0) {
                console.log(chalk.cyan('\n  Paused tasks (awaiting resume or approval):'));
                for (const task of data.haltedTasks) {
                    const label = task.status === 'halted_for_approval'
                        ? chalk.yellow('⏸ [approval needed]')
                        : chalk.gray('⏸ [paused]');
                    console.log(`    ${label} [${task.id.slice(0, 8)}] ${task.description}`);
                    console.log(chalk.gray(`      Resume: 0agent resume ${task.id}`));
                }
            }

            if (!data.activeTasks?.length && !data.haltedTasks?.length) {
                console.log('\n  No active tasks');
            }

            if (data.usage) {
                console.log(chalk.cyan('\n  Usage today:'));
                console.log(`    Tokens: ${data.usage.tokens.toLocaleString()}`);
                console.log(`    Cost:   $${data.usage.cost.toFixed(4)}`);
            }

            console.log();
        } catch {
            console.log(chalk.yellow('\n  Agent is not running. Try: 0agent start\n'));
        }
    });
