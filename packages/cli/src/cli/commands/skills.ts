/**
 * 0agent skills — List, install, and manage skills.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';

interface SkillInfo {
    name: string;
    description: string;
    enabled: boolean;
    tier: 'built-in' | 'installed';
    usageCount: number;
    lastUsedAt?: string;
}

const BASE_URL = 'http://localhost:3000';

export const skillsCommand = new Command('skills')
    .description('Manage agent skills');

skillsCommand
    .command('list')
    .description('List all installed skills')
    .action(async () => {
        try {
            const res = await fetch(`${BASE_URL}/api/skills`);
            const skills = await res.json() as SkillInfo[];

            console.log(chalk.cyan('\n  Installed skills:\n'));
            for (const skill of skills) {
                const status = skill.enabled ? chalk.green('✓') : chalk.gray('○');
                const tier = skill.tier === 'built-in' ? chalk.gray('[built-in]') : chalk.blue('[installed]');
                console.log(`  ${status} ${skill.name.padEnd(22)} ${tier} ${chalk.gray(skill.description.slice(0, 60))}`);
                const lastUsed = skill.lastUsedAt
                    ? new Date(skill.lastUsedAt).toLocaleDateString()
                    : 'never';
                console.log(chalk.gray(`      Used ${skill.usageCount}× · last: ${lastUsed}`));
            }
            console.log();
        } catch {
            console.log(chalk.yellow('\n  Agent is not running. Try: 0agent start\n'));
        }
    });

skillsCommand
    .command('install <source>')
    .description('Install a skill from a GitHub URL or local path')
    .option('--name <name>', 'Override the skill name')
    .action(async (source: string, options: { name?: string }) => {
        const spinner = ora(`Installing skill from ${source}...`).start();
        try {
            const res = await fetch(`${BASE_URL}/api/skills/install`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ source, name: options.name }),
            });

            if (!res.ok) {
                const body = await res.json() as { error?: string };
                spinner.fail(`Install failed: ${body.error ?? res.statusText}`);
                return;
            }

            const skill = await res.json() as SkillInfo;
            spinner.succeed(`Installed: ${skill.name}`);
            console.log(chalk.gray(`  ${skill.description}\n`));
        } catch (err: unknown) {
            spinner.fail(`Failed: ${(err as Error).message}`);
        }
    });

skillsCommand
    .command('enable <name>')
    .description('Enable a disabled skill')
    .action(async (name: string) => {
        const res = await fetch(`${BASE_URL}/api/skills/${name}/enable`, { method: 'POST' });
        if (res.ok) console.log(chalk.green(`\n  ✓ ${name} enabled\n`));
        else console.log(chalk.red(`\n  ✗ Could not enable ${name}\n`));
    });

skillsCommand
    .command('disable <name>')
    .description('Disable a skill without removing it')
    .action(async (name: string) => {
        const res = await fetch(`${BASE_URL}/api/skills/${name}/disable`, { method: 'POST' });
        if (res.ok) console.log(chalk.green(`\n  ✓ ${name} disabled\n`));
        else console.log(chalk.red(`\n  ✗ Could not disable ${name}\n`));
    });

skillsCommand
    .command('remove <name>')
    .description('Remove an installed skill (built-in skills cannot be removed, only disabled)')
    .action(async (name: string) => {
        const res = await fetch(`${BASE_URL}/api/skills/${name}`, { method: 'DELETE' });
        if (res.ok) {
            console.log(chalk.green(`\n  ✓ ${name} removed\n`));
        } else {
            const body = await res.json() as { error?: string };
            console.log(chalk.red(`\n  ✗ ${body.error ?? 'Could not remove'}\n`));
        }
    });
