/**
 * 0agent config — Get and set configuration values.
 * Reads/writes ~/.0agent/config.json (non-secret values only).
 * For secrets use `0agent onboard` or edit ~/.0agent/.env directly.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { CONFIG_FILE } from './onboard.js';

type ConfigValue = string | boolean | number | Record<string, unknown>;
type Config = Record<string, ConfigValue>;

function loadConfig(): Config {
    if (!existsSync(CONFIG_FILE)) return {};
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf-8')) as Config;
}

function saveConfig(config: Config): void {
    writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

export const configCommand = new Command('config')
    .description('Get and set agent configuration');

configCommand
    .command('get [key]')
    .description('Get a config value (or show all if no key given)')
    .action((key?: string) => {
        const config = loadConfig();

        if (!key) {
            console.log(chalk.cyan('\n  0agent configuration:\n'));
            for (const [k, v] of Object.entries(config)) {
                console.log(`  ${k.padEnd(30)} ${chalk.gray(JSON.stringify(v))}`);
            }
            console.log(chalk.gray('\n  Edit secrets in ~/.0agent/.env\n'));
            return;
        }

        const val = config[key];
        if (val === undefined) {
            console.log(chalk.yellow(`\n  Key '${key}' not found.\n`));
        } else {
            console.log(JSON.stringify(val));
        }
    });

configCommand
    .command('set <key> <value>')
    .description('Set a config value')
    .action((key: string, value: string) => {
        const config = loadConfig();

        // Try to parse as JSON (handles booleans, numbers, objects)
        let parsed: ConfigValue;
        try {
            parsed = JSON.parse(value) as ConfigValue;
        } catch {
            parsed = value;
        }

        config[key] = parsed;
        saveConfig(config);
        console.log(chalk.green(`\n  ✓ ${key} = ${JSON.stringify(parsed)}\n`));
        console.log(chalk.gray('  Restart the agent for changes to take effect: 0agent stop && 0agent start\n'));
    });

configCommand
    .command('reset')
    .description('Reset all configuration (prompts for confirmation)')
    .action(async () => {
        const { createInterface } = await import('readline');
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        rl.question(chalk.yellow('  Reset all configuration? This cannot be undone. [y/N] '), (answer) => {
            rl.close();
            if (answer.toLowerCase() === 'y') {
                saveConfig({});
                console.log(chalk.green('\n  ✓ Configuration reset. Run `0agent onboard` to set up again.\n'));
            } else {
                console.log(chalk.gray('\n  Cancelled.\n'));
            }
        });
    });
