/**
 * 0agent onboard — Complete setup wizard.
 *
 * Six steps:
 *   1. Check prerequisites (Node 20+, Docker, npm)
 *   2. Collect credentials (LLM, Supabase, Telegram, agent name)
 *   3. Write .env file
 *   4. Boot infrastructure (docker compose up)
 *   5. Run smoke test (single task → LLM response)
 *   6. Print success summary
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import { execaCommand } from 'execa';
import { randomUUID } from 'crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';
import WebSocket from 'ws';

// ============================================================
// Paths
// ============================================================

const CONFIG_DIR = join(homedir(), '.0agent');
const ENV_PATH = join(CONFIG_DIR, '.env');
const CONFIG_PATH = join(CONFIG_DIR, 'config.json');

// Exported for other commands (config.ts, start.ts)
export const CONFIG_FILE = CONFIG_PATH;
export const ENV_FILE = ENV_PATH;

function getProjectRoot(): string {
    // Walk up from this file to find the repo root (contains infra/docker-compose.yml)
    const thisDir = fileURLToPath(new URL('.', import.meta.url));
    // From src/cli/commands/ → walk up to find the repo root
    let dir = resolve(thisDir);
    for (let i = 0; i < 10; i++) {
        if (existsSync(join(dir, 'infra', 'docker-compose.yml'))) {
            return dir;
        }
        const parent = resolve(dir, '..');
        if (parent === dir) break; // reached filesystem root
        dir = parent;
    }
    // Fallback: assume CWD is the repo root
    return process.cwd();
}

// ============================================================
// Step 1: Prerequisites
// ============================================================

async function checkPrerequisites(): Promise<boolean> {
    const spinner = ora('Checking prerequisites...').start();
    const issues: string[] = [];

    // Node.js 20+
    const [major] = process.versions.node.split('.').map(Number);
    if ((major ?? 0) < 20) {
        issues.push(
            `Node.js 20+ required (you have ${process.versions.node}).\n` +
            `  Install: ${chalk.cyan('https://nodejs.org')} or ${chalk.cyan('nvm install 22')}`
        );
    }

    // Docker
    try {
        await execaCommand('docker info', { timeout: 10000 });
    } catch {
        issues.push(
            `Docker is not running.\n` +
            `  Install: ${chalk.cyan('https://docs.docker.com/get-docker/')}\n` +
            `  Then start Docker Desktop and try again.`
        );
    }

    // npm
    try {
        await execaCommand('npm --version', { timeout: 5000 });
    } catch {
        issues.push(
            `npm is not installed.\n` +
            `  Install Node.js from ${chalk.cyan('https://nodejs.org')} (npm is included).`
        );
    }

    if (issues.length > 0) {
        spinner.fail('Prerequisites not met');
        console.log('');
        for (const issue of issues) {
            console.log(chalk.red('  ✗ ') + issue);
            console.log('');
        }
        return false;
    }

    spinner.succeed('Prerequisites OK');
    return true;
}

// ============================================================
// Step 2: Collect Credentials
// ============================================================

interface OnboardAnswers {
    agentName: string;
    llmProvider: string;
    anthropicKey: string;
    openaiKey: string;
    supabaseUrl: string;
    supabaseKey: string;
    telegramToken: string;
    telegramUserId: string;
}

async function collectCredentials(): Promise<OnboardAnswers> {
    console.log('');
    console.log(chalk.bold('  Configure your agent'));
    console.log(chalk.dim('  Press Enter to accept defaults.\n'));

    const answers = await inquirer.prompt([
        {
            type: 'input',
            name: 'agentName',
            message: 'Agent name:',
            default: '0agent',
        },
        {
            type: 'list',
            name: 'llmProvider',
            message: 'LLM provider:',
            choices: [
                { name: 'Anthropic (Claude)', value: 'anthropic' },
                { name: 'OpenAI (GPT)', value: 'openai' },
                { name: 'Both', value: 'both' },
            ],
        },
        {
            type: 'password',
            name: 'anthropicKey',
            message: 'Anthropic API key:',
            mask: '*',
            when: (ans: { llmProvider: string }) => ans.llmProvider === 'anthropic' || ans.llmProvider === 'both',
            validate: (v: string) => v.length > 0 || 'API key is required',
        },
        {
            type: 'password',
            name: 'openaiKey',
            message: 'OpenAI API key:',
            mask: '*',
            when: (ans: { llmProvider: string }) => ans.llmProvider === 'openai' || ans.llmProvider === 'both',
            validate: (v: string) => v.length > 0 || 'API key is required',
        },
        {
            type: 'input',
            name: 'supabaseUrl',
            message: 'Supabase Project URL (needed for persistent memory):',
            suffix: chalk.dim('\n  Leaving blank uses local Docker (memory will be EPHEMERAL/lost on restart).\n  Find your URL in Supabase Dashboard -> Settings -> API'),
            default: '',
        },
        {
            type: 'password',
            name: 'supabaseKey',
            message: 'Supabase service key:',
            mask: '*',
            when: (ans: { supabaseUrl: string }) => ans.supabaseUrl.length > 0,
        },
        {
            type: 'input',
            name: 'telegramToken',
            suffix: chalk.dim(`\n  To get one: (1) Open Telegram, search @BotFather\n  (2) Send /newbot and follow the prompts\n  (3) Copy the full token (e.g. 1234567:ABC...)`),
            validate: (v: string) => v.length === 0 || v.includes(':') || 'Token usually contains a colon (e.g. 1234567:ABC)',
        },
        {
            type: 'input',
            name: 'telegramUserId',
            message: 'Your Telegram User ID (for security — optional):',
            suffix: chalk.dim('\n  Only this USER_ID will be allowed to talk to the bot.\n  Find your ID by messaging @userinfobot or @myidbot on Telegram.'),
            when: (ans: any) => !!ans.telegramToken,
        },
    ]);

    return answers as OnboardAnswers;
}

// ============================================================
// Step 3: Write .env
// ============================================================

function writeEnvFile(answers: OnboardAnswers, projectRoot: string): void {
    const spinner = ora('Writing configuration...').start();

    mkdirSync(CONFIG_DIR, { recursive: true });

    const agentId = randomUUID();
    const companyId = randomUUID();
    const serviceToken = randomUUID();
    const encryptionKey = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');

    // Use Docker-local defaults if no Supabase URL provided
    const useLocalDb = !answers.supabaseUrl;
    const dbPass = `0agent_local_${randomUUID().slice(0, 8)}`;
    const dbHost = useLocalDb ? 'postgres' : 'localhost'; // localhost for CLI access, postgres for runtime

    let dbUrl = `postgresql://onlyreason:${dbPass}@${dbHost}:5432/onlyreason`;

    const envContent = `# ⬡ 0agent Configuration — ${new Date().toISOString()}
# =============================================================================

# ─────────────────────────────────────────────────────────────────────────────
# 1. IDENTITY & TENANCY
# ─────────────────────────────────────────────────────────────────────────────
AGENT_ID=${agentId}
COMPANY_ID=${companyId}
AGENT_NAME=${answers.agentName}
SERVICE_TOKEN=${serviceToken}

# ─────────────────────────────────────────────────────────────────────────────
# 2. DATABASE (Supabase or Local)
# ─────────────────────────────────────────────────────────────────────────────
# URL used by the runtime to talk to the Supabase API
SUPABASE_URL=${answers.supabaseUrl || 'http://localhost:8000'}
SUPABASE_SERVICE_KEY=${answers.supabaseKey || 'local-dev-key'}

# Raw Postgres connection (used for migrations and local state)
POSTGRES_HOST=${useLocalDb ? 'postgres' : ''}
POSTGRES_PORT=5432
POSTGRES_DB=onlyreason
POSTGRES_USER=onlyreason
POSTGRES_PASSWORD=${dbPass}
DATABASE_URL=${dbUrl}

# ─────────────────────────────────────────────────────────────────────────────
# 3. INFRASTRUCTURE
# ─────────────────────────────────────────────────────────────────────────────
REDIS_HOST=redis
REDIS_PORT=6379
REDIS_PASSWORD=

# ─────────────────────────────────────────────────────────────────────────────
# 4. LLM PROVIDERS
# ─────────────────────────────────────────────────────────────────────────────
ANTHROPIC_API_KEY=${answers.anthropicKey || ''}
OPENAI_API_KEY=${answers.openaiKey || ''}
DEFAULT_MODEL=${answers.llmProvider === 'openai' ? 'gpt-4o-mini' : 'claude-sonnet-4-6'}

# ─────────────────────────────────────────────────────────────────────────────
# 5. SECURITY & FEATURE FLAGS
# ─────────────────────────────────────────────────────────────────────────────
CREDENTIAL_ENCRYPTION_KEY=${encryptionKey}
JUDGMENT_SERVICE_URL=http://judgment:8001

# Telegram Integration
TELEGRAM_BOT_TOKEN=${answers.telegramToken || ''}
TELEGRAM_USER_ID=${answers.telegramUserId || ''}
FEATURE_TELEGRAM=${answers.telegramToken ? 'true' : 'false'}

# Development & Logging
LOG_LEVEL=info
HEARTBEAT_INTERVAL_SECONDS=30

# System Features
FEATURE_SKILLS=true
FEATURE_BROWSER=true
FEATURE_SCHEDULER=true
`.trim();

    writeFileSync(ENV_PATH, envContent, 'utf-8');

    // Also write config.json for CLI state
    const config = {
        agentName: answers.agentName,
        agentId,
        companyId,
        llmProvider: answers.llmProvider,
        setupAt: new Date().toISOString(),
        envPath: ENV_PATH,
        telegramConfigured: !!answers.telegramToken,
    };
    writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');

    spinner.succeed(`Configuration written to ${chalk.dim(CONFIG_DIR)} `);
}

// ============================================================
// Step 4: Boot Infrastructure
// ============================================================

async function bootInfrastructure(projectRoot: string): Promise<boolean> {
    const composeFile = join(projectRoot, 'infra', 'docker-compose.yml');

    if (!existsSync(composeFile)) {
        console.log(chalk.red('  ✗ docker-compose.yml not found at: ' + composeFile));
        console.log(chalk.dim('    Make sure you are running from the 0agent project directory.'));
        return false;
    }

    const spinner = ora('Starting infrastructure (this may take a minute)...').start();

    try {
        // Build and start only essential containers
        await execaCommand(
            `docker compose - f ${composeFile} --env - file ${ENV_PATH} up - d--build postgres redis runtime`,
            { timeout: 300000 }
        );
        spinner.text = 'Containers started. Waiting for services to be healthy...';

        // Wait for runtime health check (up to 90 seconds)
        const maxWait = 90000;
        const start = Date.now();
        let healthy = false;

        while (Date.now() - start < maxWait) {
            try {
                const res = await fetch('http://localhost:3000/health');
                if (res.ok) {
                    healthy = true;
                    break;
                }
            } catch {
                // Not ready yet
            }
            await new Promise(r => setTimeout(r, 3000));
            const elapsed = Math.round((Date.now() - start) / 1000);
            spinner.text = `Waiting for runtime to be healthy... (${elapsed}s)`;
        }

        if (!healthy) {
            spinner.fail('Runtime did not become healthy within 90 seconds');
            console.log('');
            console.log(chalk.yellow('  Check the logs:'));
            try {
                const { stdout } = await execaCommand(
                    `docker compose - f "${composeFile}" logs--tail = 20 runtime`,
                    { shell: true }
                );
                console.log(chalk.dim(stdout));
            } catch { /* ignore */ }
            return false;
        }

        spinner.succeed('Infrastructure is running');
        return true;
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        spinner.fail('Failed to start infrastructure');
        console.log('');
        if (msg.includes('Cannot connect to the Docker daemon')) {
            console.log(chalk.red('  Docker is not running. Start Docker Desktop and try again.'));
        } else if (msg.includes('port is already allocated')) {
            console.log(chalk.red('  A port is already in use. Run: docker compose down'));
        } else {
            console.log(chalk.red('  ' + msg.slice(0, 300)));
        }
        return false;
    }
}

// ============================================================
// Step 5: Smoke Test
// ============================================================

async function runSmokeTest(telegramToken: string): Promise<boolean> {
    const spinner = ora('Running smoke test — asking your agent a question...').start();

    return new Promise<boolean>((resolvePromise) => {
        const timeout = setTimeout(() => {
            spinner.fail('Smoke test timed out after 60 seconds');
            console.log(chalk.dim('  The runtime may not be fully initialized yet.'));
            console.log(chalk.dim('  Try: 0agent task "What is today\'s date?"'));
            resolvePromise(false);
        }, 60000);

        try {
            const ws = new WebSocket('ws://localhost:3000/ws');
            let gotResponse = false;
            let responseText = '';

            ws.on('open', () => {
                spinner.text = 'Connected to runtime. Sending test task...';
                ws.send(JSON.stringify({
                    type: 'task',
                    payload: { task: "What is today's date? Reply in one sentence." },
                }));
            });

            ws.on('message', async (data: Buffer) => {
                try {
                    const msg = JSON.parse(data.toString()) as { type: string; chunk?: string };

                    if (msg.type === 'stream' && msg.chunk) {
                        responseText += msg.chunk;
                    }

                    if (msg.type === 'done') {
                        gotResponse = true;
                        clearTimeout(timeout);
                        ws.close();

                        spinner.succeed('Smoke test passed!');
                        console.log('');
                        console.log(chalk.green('  Agent responded:'));
                        console.log(chalk.white('  ' + (responseText || '(task completed)').slice(0, 500)));
                        console.log('');

                        // If Telegram configured, send the result there too
                        if (telegramToken) {
                            try {
                                const meRes = await fetch(`https://api.telegram.org/bot${telegramToken}/getMe`);
                                const me = (await meRes.json()) as { ok: boolean; result?: { username?: string } };
                                if (me.ok) {
                                    console.log(chalk.dim(`  Telegram bot @${me.result?.username} is ready.`));
                                    console.log(chalk.dim('  Send it a message to test: 0agent telegram'));
                                }
                            } catch { /* ignore */ }
                        }

                        resolvePromise(true);
                    }

                    if (msg.type === 'error') {
                        clearTimeout(timeout);
                        ws.close();
                        spinner.fail('Smoke test failed — the agent returned an error');
                        console.log(chalk.red('  ' + JSON.stringify(msg).slice(0, 300)));
                        resolvePromise(false);
                    }
                } catch { /* ignore parse errors */ }
            });

            ws.on('error', (err) => {
                clearTimeout(timeout);
                spinner.fail('Could not connect to runtime');
                console.log(chalk.red('  ' + err.message));
                console.log(chalk.dim('  Make sure 0agent start has been run.'));
                resolvePromise(false);
            });

            ws.on('close', () => {
                if (!gotResponse) {
                    clearTimeout(timeout);
                    spinner.fail('Connection closed before receiving a response');
                    resolvePromise(false);
                }
            });
        } catch (err) {
            clearTimeout(timeout);
            spinner.fail('Smoke test failed');
            console.log(chalk.red('  ' + (err instanceof Error ? err.message : String(err))));
            resolvePromise(false);
        }
    });
}

// ============================================================
// Step 6: Success Summary
// ============================================================

function printSummary(answers: OnboardAnswers): void {
    console.log('');
    console.log(chalk.green.bold('  ⬡ 0agent is now live!'));
    console.log(chalk.dim('  ─────────────────────────────────'));
    console.log('');

    console.log(chalk.bold('  Quick-access commands:'));
    console.log(`    ${chalk.cyan('0agent task')} "..."      ${chalk.dim('Prompt your agent directly from CLI')}`);
    console.log(`    ${chalk.cyan('0agent status')}          ${chalk.dim('Check system health and active sessions')}`);
    console.log(`    ${chalk.cyan('0agent logs')}            ${chalk.dim('Stream live interaction trails')}`);

    if (answers.telegramToken) {
        console.log(`    ${chalk.magenta('Telegram Bot')}        ${chalk.dim('Your bot is listening at Telegram')}`);
    }

    console.log(`    ${chalk.red('0agent stop')}            ${chalk.dim('Shut down all services safely')}`);
    console.log('');

    console.log(chalk.bold('  First steps:'));
    console.log(`    1. Message your bot on Telegram with ${chalk.white('"Hello!"')}`);
    console.log(`    2. Try a CLI task: ${chalk.white('0agent task "Check my recent emails"')}`);
    console.log('');

    console.log(chalk.bold('  Configuration saved to:'));
    console.log(`    ${chalk.dim(CONFIG_DIR)}`);
    console.log('');
}

// ============================================================
// Command
// ============================================================

export const onboardCommand = new Command('onboard')
    .description('Set up your 0agent — interactive wizard')
    .option('--reset', 'Start fresh, overwriting existing config')
    .action(async (opts: { reset?: boolean }) => {
        console.log('');
        console.log(chalk.bold.cyan('  ⬡ 0agent setup wizard'));
        console.log(chalk.dim('  ─────────────────────────────────'));
        console.log('');

        // Check for existing setup
        if (!opts.reset && existsSync(ENV_PATH)) {
            const { overwrite } = await inquirer.prompt([{
                type: 'confirm',
                name: 'overwrite',
                message: 'Existing configuration found. Overwrite?',
                default: false,
            }]);
            if (!overwrite) {
                console.log(chalk.dim('  Keeping existing config. Use --reset to start fresh.'));
                return;
            }
        }

        // Step 1: Prerequisites
        const prereqsOk = await checkPrerequisites();
        if (!prereqsOk) {
            console.log(chalk.dim('\n  Fix the issues above and run: 0agent onboard\n'));
            process.exit(1);
        }

        // Step 2: Collect credentials
        const answers = await collectCredentials();

        // Step 3: Write .env
        const projectRoot = getProjectRoot();
        writeEnvFile(answers, projectRoot);

        // Step 4: Boot infrastructure
        const booted = await bootInfrastructure(projectRoot);
        if (!booted) {
            console.log('');
            console.log(chalk.yellow('  Your config has been saved. To retry:'));
            console.log(chalk.dim('    0agent start'));
            console.log('');
            return;
        }

        // Step 5: Smoke test
        const passed = await runSmokeTest(answers.telegramToken);

        // Step 6: Summary (show even if smoke test failed)
        printSummary(answers);

        if (!passed) {
            console.log(chalk.yellow('  The smoke test didn\'t pass, but your config is saved.'));
            console.log(chalk.yellow('  Try manually: 0agent task "hello"'));
            console.log('');
        }
    });
