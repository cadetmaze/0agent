/**
 * 0agent start — Start the 0agent runtime via docker compose.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { execa } from 'execa';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { CONFIG_FILE, ENV_FILE } from './onboard.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function getComposeFile(): string {
    return join(__dirname, '../../../../../infra/docker-compose.yml');
}

export const startCommand = new Command('start')
    .description('Start the 0agent runtime')
    .option('-d, --daemon', 'Run in background (detached)')
    .action(async (options: { daemon?: boolean }) => {
        if (!existsSync(CONFIG_FILE)) {
            console.log(chalk.yellow('\n  Run `0agent onboard` first to set up.\n'));
            process.exit(1);
        }

        // Silently check for updates — non-blocking
        void checkForUpdateSilently();

        const spinner = ora('Starting 0agent...').start();

        try {
            const composeArgs = [
                'compose',
                '-f', getComposeFile(),
                '--env-file', ENV_FILE,
                'up',
                '--build',
                ...(options.daemon ? ['-d'] : []),
            ];

            await execa('docker', composeArgs, {
                stdio: options.daemon ? 'pipe' : 'inherit',
            });

            if (options.daemon) {
                spinner.succeed('0agent running in background');
                console.log(`\n  API:  ${chalk.cyan('http://localhost:3000')}`);
                console.log(`  Logs: ${chalk.gray('0agent logs --tail')}`);
                console.log(`  Stop: ${chalk.gray('0agent stop')}\n`);
            }
        } catch (err: unknown) {
            spinner.fail('Failed to start');
            console.error((err as Error).message);
            process.exit(1);
        }
    });

async function checkForUpdateSilently(): Promise<void> {
    try {
        const { readFileSync } = await import('fs');
        const pkg = JSON.parse(
            readFileSync(join(__dirname, '../../../../package.json'), 'utf8')
        ) as { version: string };

        const res = await fetch('https://registry.npmjs.org/0agent/latest', {
            signal: AbortSignal.timeout(3000),
        });
        const data = await res.json() as { version: string };

        if (data.version !== pkg.version) {
            console.log(chalk.yellow(`\n  Update available: ${pkg.version} → ${data.version}`));
            console.log(chalk.gray('  Run `0agent update` to upgrade\n'));
        }
    } catch {
        // Fail silently — network unavailable or registry slow
    }
}
