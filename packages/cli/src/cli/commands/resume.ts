/**
 * 0agent resume — Resume a paused or approval-halted task.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';

export const resumeCommand = new Command('resume')
    .description('Resume a paused task')
    .argument('<taskId>', 'Task ID to resume')
    .action(async (taskId: string) => {
        const spinner = ora(`Resuming task ${taskId.slice(0, 8)}...`).start();

        try {
            const res = await fetch(`http://localhost:3000/api/tasks/${taskId}/resume`, {
                method: 'POST',
            });

            if (res.ok) {
                spinner.succeed(`Task ${taskId.slice(0, 8)} resumed`);
                console.log(chalk.gray(`  Stream output: 0agent logs --tail --task ${taskId}\n`));
            } else {
                const body = await res.json() as { error?: string };
                spinner.fail(`Could not resume: ${body.error ?? res.statusText}`);
            }
        } catch {
            spinner.fail('Agent is not running. Try: 0agent start');
        }
    });
