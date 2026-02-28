/**
 * CLI root — wires all commands together via Commander.
 * Entry point after the bin/0agent.js shebang.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { onboardCommand } from './commands/onboard.js';
import { startCommand } from './commands/start.js';
import { stopCommand } from './commands/stop.js';
import { statusCommand } from './commands/status.js';
import { taskCommand } from './commands/task.js';
import { skillsCommand } from './commands/skills.js';
import { logsCommand } from './commands/logs.js';
import { memoryCommand } from './commands/memory.js';
import { updateCommand } from './commands/update.js';
import { configCommand } from './commands/config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '../../../package.json'), 'utf8')) as { version: string };

const program = new Command();

program
    .name('0agent')
    .description(chalk.cyan('The judgment-native AI agent by Only Reason'))
    .version(pkg.version, '-v, --version');

program.addCommand(onboardCommand);
program.addCommand(startCommand);
program.addCommand(stopCommand);
program.addCommand(statusCommand);
program.addCommand(taskCommand);
program.addCommand(skillsCommand);
program.addCommand(logsCommand);
program.addCommand(memoryCommand);
program.addCommand(updateCommand);
program.addCommand(configCommand);

// Show help if no command given
program.action(() => {
    console.log(chalk.cyan('\n  0agent — by Only Reason\n'));
    console.log('  Quick start:');
    console.log(chalk.gray('    npx 0agent onboard     ') + '← run this first');
    console.log(chalk.gray('    0agent start           ') + '← start the agent');
    console.log(chalk.gray('    0agent task "..."      ') + '← give it a task');
    console.log(chalk.gray('    0agent status          ') + '← see what\'s running');
    console.log(chalk.gray('    0agent stop            ') + '← stop it\n');
    program.outputHelp();
});

program.parseAsync(process.argv).catch((err: Error) => {
    console.error(chalk.red('Error:'), err.message);
    process.exit(1);
});
