/**
 * 0agent onboard — First-run setup wizard.
 *
 * Checks Docker, collects API key + options, writes ~/.0agent/config.json
 * and ~/.0agent/.env, pulls Docker images, optionally installs a daemon.
 */

import { Command } from 'commander';
import inquirer from 'inquirer';
import chalk from 'chalk';
import ora from 'ora';
import { execa } from 'execa';
import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const CONFIG_DIR = join(homedir(), '.0agent');
export const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
export const ENV_FILE = join(CONFIG_DIR, '.env');

function getComposeFile(): string {
    // Walks up to find docker-compose.yml shipped with the package
    return join(__dirname, '../../../../infra/docker-compose.yml');
}

export const onboardCommand = new Command('onboard')
    .description('Set up 0agent for the first time (run this first)')
    .option('--reset', 'Reset all configuration and start over')
    .action(async (options: { reset?: boolean }) => {
        if (options.reset && existsSync(CONFIG_FILE)) {
            console.log(chalk.yellow('\n  Resetting configuration...\n'));
        }

        console.log(chalk.cyan('\n  Welcome to 0agent\n'));
        console.log('  This takes about 2 minutes.\n');

        // 1. Check Docker
        const dockerSpinner = ora('Checking Docker...').start();
        try {
            await execa('docker', ['info'], { stdio: 'pipe' });
            dockerSpinner.succeed('Docker is running');
        } catch {
            dockerSpinner.fail('Docker is not running');
            console.log(chalk.yellow('\n  Docker is required. Install it at https://docker.com\n'));
            process.exit(1);
        }

        // 2. Collect configuration
        const answers = await inquirer.prompt([
            {
                type: 'password',
                name: 'anthropicKey',
                message: 'Anthropic API key (get one at console.anthropic.com):',
                validate: (v: string) =>
                    v.startsWith('sk-ant-') ? true : 'Should start with sk-ant-',
            },
            {
                type: 'password',
                name: 'openaiKey',
                message: 'OpenAI API key (optional, for GPT-4o fallback, press Enter to skip):',
                default: '',
            },
            {
                type: 'input',
                name: 'telegramToken',
                message: 'Telegram bot token (optional, press Enter to skip):',
                default: '',
            },
            {
                type: 'list',
                name: 'model',
                message: 'Default model:',
                choices: [
                    { name: 'Claude Opus 4.6     (best, slower,  ~$15/M tokens)', value: 'claude-opus-4-5' },
                    { name: 'Claude Sonnet 4.6   (fast, smart,   ~$3/M tokens) ←recommended', value: 'claude-sonnet-4-5' },
                    { name: 'Claude Haiku 4.5    (fastest, cheapest, ~$0.25/M)', value: 'claude-haiku-4-5-20251001' },
                ],
                default: 'claude-sonnet-4-5',
            },
            {
                type: 'confirm',
                name: 'installDaemon',
                message: 'Keep 0agent running in background automatically? (recommended)',
                default: true,
            },
        ]) as {
            anthropicKey: string;
            openaiKey: string;
            telegramToken: string;
            model: string;
            installDaemon: boolean;
        };

        // 3. Write config.json
        if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });

        const config = {
            version: '0.1.0',
            model: answers.model,
            telegram: answers.telegramToken ? { botToken: answers.telegramToken } : undefined,
            features: {
                skills: true,
                browser: true,
                scheduler: true,
                contextCompression: true,
                promptCaching: true,
                telegram: !!answers.telegramToken,
                voice: false,
                mcp: false,
            },
        };
        writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));

        // 4. Write .env
        const lines = [
            `ANTHROPIC_API_KEY=${answers.anthropicKey}`,
            answers.openaiKey ? `OPENAI_API_KEY=${answers.openaiKey}` : '',
            answers.telegramToken ? `TELEGRAM_BOT_TOKEN=${answers.telegramToken}` : '',
            `DEFAULT_MODEL=${answers.model}`,
            `AGENT_ID=${crypto.randomUUID()}`,
            `COMPANY_ID=${crypto.randomUUID()}`,
            `SERVICE_TOKEN=${crypto.randomUUID()}`,
            `CREDENTIAL_ENCRYPTION_KEY=${crypto.randomUUID().replace(/-/g, '')}${crypto.randomUUID().replace(/-/g, '')}`,
        ].filter(Boolean);
        writeFileSync(ENV_FILE, lines.join('\n') + '\n');

        // 5. Pull Docker images
        const pullSpinner = ora('Pulling Docker images (first time ~2 minutes)...').start();
        try {
            await execa('docker', [
                'compose', '-f', getComposeFile(), '--env-file', ENV_FILE, 'pull',
            ], { stdio: 'pipe' });
            pullSpinner.succeed('Docker images ready');
        } catch (err) {
            pullSpinner.warn('Could not pull images now — will pull on first start');
        }

        // 6. Optionally install daemon
        if (answers.installDaemon) {
            await installDaemon();
        }

        // 7. Done
        console.log(chalk.green('\n  ✓ 0agent is ready\n'));
        console.log('  Run:');
        console.log(chalk.cyan('    0agent start'));
        console.log(chalk.cyan('    0agent task "research competitors for [your company]"'));
        console.log();

        if (answers.telegramToken) {
            console.log('  Telegram: send /start to your bot to connect\n');
        }
    });

async function installDaemon(): Promise<void> {
    const spinner = ora('Installing background service...').start();
    const platform = process.platform;

    try {
        if (platform === 'darwin') {
            const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>ai.onlyreason.0agent</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${process.argv[1]}</string>
    <string>start</string>
    <string>--daemon</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${join(CONFIG_DIR, 'daemon.log')}</string>
  <key>StandardErrorPath</key><string>${join(CONFIG_DIR, 'daemon.err')}</string>
</dict>
</plist>`;
            const plistPath = join(homedir(), 'Library/LaunchAgents/ai.onlyreason.0agent.plist');
            writeFileSync(plistPath, plistContent);
            await execa('launchctl', ['load', plistPath]);

        } else if (platform === 'linux') {
            const serviceContent = `[Unit]
Description=0agent AI Agent
After=network.target

[Service]
ExecStart=${process.execPath} ${process.argv[1]} start --daemon
Restart=always
Environment=HOME=${homedir()}

[Install]
WantedBy=default.target`;
            const serviceDir = join(homedir(), '.config/systemd/user');
            mkdirSync(serviceDir, { recursive: true });
            writeFileSync(join(serviceDir, '0agent.service'), serviceContent);
            await execa('systemctl', ['--user', 'enable', '0agent']);
            await execa('systemctl', ['--user', 'start', '0agent']);
        } else {
            spinner.warn('Daemon auto-start not supported on this platform — run `0agent start` manually');
            return;
        }

        spinner.succeed('Background service installed — 0agent starts automatically on login');
    } catch {
        spinner.warn('Could not install background service — run `0agent start` manually');
    }
}
