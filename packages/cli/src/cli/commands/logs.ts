/**
 * 0agent logs — Tail live task logs from the agent runtime.
 */

import { Command } from 'commander';
import chalk from 'chalk';

export const logsCommand = new Command('logs')
    .description('View agent logs')
    .option('--tail', 'Follow log output in real-time (Ctrl+C to stop)')
    .option('--task <id>', 'Filter logs to a specific task')
    .option('--level <level>', 'Filter by log level: debug, info, warn, error', 'info')
    .option('-n, --lines <n>', 'Number of past lines to show', '50')
    .action(async (options: { tail?: boolean; task?: string; level: string; lines: string }) => {
        const params = new URLSearchParams({
            level: options.level,
            lines: options.lines,
            ...(options.task ? { taskId: options.task } : {}),
        });

        if (options.tail) {
            // Server-Sent Events for real-time streaming
            console.log(chalk.gray('  Streaming logs (Ctrl+C to stop)...\n'));

            try {
                const res = await fetch(`http://localhost:3000/api/logs/stream?${params}`, {
                    headers: { Accept: 'text/event-stream' },
                });

                if (!res.ok || !res.body) {
                    console.log(chalk.yellow('  Could not connect to log stream.'));
                    return;
                }

                const reader = res.body.getReader();
                const decoder = new TextDecoder();

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;

                    const text = decoder.decode(value);
                    for (const line of text.split('\n')) {
                        if (!line.startsWith('data:')) continue;
                        try {
                            const entry = JSON.parse(line.slice(5)) as {
                                level: string; ts: string; msg: string; taskId?: string;
                            };

                            const levelColor: Record<string, (s: string) => string> = {
                                debug: chalk.gray,
                                info: chalk.white,
                                warn: chalk.yellow,
                                error: chalk.red,
                            };

                            const color = levelColor[entry.level] ?? chalk.white;
                            const ts = new Date(entry.ts).toLocaleTimeString();
                            const taskTag = entry.taskId ? chalk.gray(` [${entry.taskId.slice(0, 8)}]`) : '';
                            console.log(`  ${chalk.gray(ts)} ${color(entry.level.toUpperCase().padEnd(5))}${taskTag} ${color(entry.msg)}`);
                        } catch { /* skip malformed events */ }
                    }
                }
            } catch {
                console.log(chalk.yellow('\n  Agent is not running. Try: 0agent start\n'));
            }
        } else {
            // Fetch historical logs
            try {
                const res = await fetch(`http://localhost:3000/api/logs?${params}`);
                const entries = await res.json() as Array<{
                    level: string; ts: string; msg: string; taskId?: string;
                }>;

                if (entries.length === 0) {
                    console.log(chalk.gray('\n  No logs found.\n'));
                    return;
                }

                console.log();
                for (const entry of entries) {
                    const levelColor: Record<string, (s: string) => string> = {
                        debug: chalk.gray, info: chalk.white, warn: chalk.yellow, error: chalk.red,
                    };
                    const color = levelColor[entry.level] ?? chalk.white;
                    const ts = new Date(entry.ts).toLocaleTimeString();
                    const taskTag = entry.taskId ? chalk.gray(` [${entry.taskId.slice(0, 8)}]`) : '';
                    console.log(`  ${chalk.gray(ts)} ${color(entry.level.toUpperCase().padEnd(5))}${taskTag} ${color(entry.msg)}`);
                }
                console.log();
            } catch {
                console.log(chalk.yellow('\n  Agent is not running. Try: 0agent start\n'));
            }
        }
    });
