/**
 * Entry point — Only Reason 0 Agent Runtime
 *
 * Boots the agent and handles graceful shutdown on SIGTERM/SIGINT.
 */

import { Agent } from './agent.js';

async function main(): Promise<void> {
    const agent = new Agent();

    // Handle graceful shutdown
    const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];
    for (const signal of signals) {
        process.on(signal, () => {
            console.log(`\nReceived ${signal}, shutting down gracefully...`);
            void agent.shutdown().then(() => {
                process.exit(0);
            });
        });
    }

    // Handle uncaught exceptions
    process.on('uncaughtException', (error) => {
        console.error('[FATAL] Uncaught exception:', error);
        void agent.shutdown().then(() => {
            process.exit(1);
        });
    });

    process.on('unhandledRejection', (reason) => {
        console.error('[FATAL] Unhandled rejection:', reason);
        void agent.shutdown().then(() => {
            process.exit(1);
        });
    });

    // Boot the agent
    await agent.boot();

    // Start Telegram listener if enabled
    if (process.env['FEATURE_TELEGRAM'] === 'true' && process.env['TELEGRAM_BOT_TOKEN']) {
        const { TelegramListener } = await import('./adapters/telegram-listener.js');
        const listener = new TelegramListener(
            process.env['TELEGRAM_BOT_TOKEN'],
            process.env['TELEGRAM_USER_ID'] || null
        );
        console.log('[Runtime] Starting Telegram listener...');
        void listener.start();
    }
}

main().catch((error) => {
    console.error('[FATAL] Failed to start agent:', error);
    process.exit(1);
});
