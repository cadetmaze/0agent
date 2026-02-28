/**
 * 0agent update — Self-update via npm registry.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { execa } from 'execa';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const { version: currentVersion } = JSON.parse(
    readFileSync(join(__dirname, '../../../package.json'), 'utf8')
) as { version: string };

export const updateCommand = new Command('update')
    .description('Update 0agent to the latest version')
    .option('--version <ver>', 'Install a specific version instead of latest')
    .action(async (options: { version?: string }) => {
        const spinner = ora('Checking for updates...').start();

        try {
            const res = await fetch('https://registry.npmjs.org/0agent/latest', {
                signal: AbortSignal.timeout(5000),
            });
            const data = await res.json() as { version: string };
            const target = options.version ?? data.version;

            if (target === currentVersion && !options.version) {
                spinner.succeed(`Already up to date (${currentVersion})`);
                return;
            }

            spinner.text = `Updating from ${currentVersion} → ${target}...`;

            await execa('npm', ['install', '-g', `0agent@${target}`], {
                stdio: 'pipe',
            });

            spinner.succeed(`Updated to ${target}`);
            console.log(chalk.gray('\n  Restart with `0agent start` to apply.\n'));
        } catch (err: unknown) {
            spinner.fail(`Update failed: ${(err as Error).message}`);
        }
    });
