/**
 * 0agent stop — Hard interrupt a task or shut down the whole agent.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';

export const stopCommand = new Command('stop')
    .description('Stop the agent or a specific task')
    .option('--task <id>', 'Stop a specific task only (preserves agent runtime)')
    .option('--force', 'Kill without preserving state')
    .action(async (options: { task?: string; force?: boolean }) => {
        if (options.task) {
            // Stop a single task — interrupt is set in Redis by the runtime
            try {
                const res = await fetch(`http://localhost:3000/api/tasks/${options.task}/stop`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ force: options.force ?? false }),
                });

                if (res.ok) {
                    console.log(chalk.green(`\n  ✓ Task ${options.task} stopped. State preserved.\n`));
                    console.log(chalk.gray(`  Resume with: 0agent task-resume ${options.task}\n`));
                } else {
                    const body = await res.json() as { error?: string };
                    console.log(chalk.red(`\n  ✗ Could not stop task: ${body.error ?? res.statusText}\n`));
                }
            } catch {
                console.log(chalk.yellow('\n  Agent is not responding. Try: docker compose down\n'));
            }
        } else {
            // Stop the full agent runtime
            const spinner = ora('Stopping 0agent...').start();

            try {
                // Graceful API shutdown first
                await fetch('http://localhost:3000/api/stop', {
                    method: 'POST',
                    signal: AbortSignal.timeout(3000),
                }).catch(() => { /* ignore — process may already be stopping */ });

                await new Promise((r) => setTimeout(r, 1500));

                // docker compose down
                const { execa } = await import('execa');
                const { fileURLToPath } = await import('url');
                const { dirname, join } = await import('path');
                const __dirname = dirname(fileURLToPath(import.meta.url));
                const composeFile = join(__dirname, '../../../../../infra/docker-compose.yml');

                await execa('docker', ['compose', '-f', composeFile, 'down'], {
                    stdio: 'pipe',
                });

                spinner.succeed('0agent stopped');
            } catch {
                // If the API is already down, just run compose down
                try {
                    const { execa } = await import('execa');
                    await execa('docker', ['compose', 'down'], { stdio: 'inherit' });
                    spinner.succeed('0agent stopped');
                } catch (err) {
                    spinner.fail(`Stop failed: ${(err as Error).message}`);
                }
            }
        }
    });
