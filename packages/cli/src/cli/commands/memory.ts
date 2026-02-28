/**
 * 0agent memory — Search and manage KG memory nodes.
 */

import { Command } from 'commander';
import chalk from 'chalk';

interface MemoryNode {
    id: string;
    nodeType: string;
    title: string;
    content: string;
    importance: number;
    createdAt: string;
    taskId?: string;
}

const BASE_URL = 'http://localhost:3000';

export const memoryCommand = new Command('memory')
    .description('Search and manage agent memory');

memoryCommand
    .command('search [query]')
    .description('Search memory nodes (omit query to list recent)')
    .option('--type <type>', 'Filter by node type (decision, context, org_entity, etc.)')
    .option('--limit <n>', 'Max results', '10')
    .action(async (query: string | undefined, options: { type?: string; limit: string }) => {
        try {
            const params = new URLSearchParams();
            if (query) params.set('q', query);
            if (options.type) params.set('type', options.type);
            params.set('limit', options.limit);

            const res = await fetch(`${BASE_URL}/api/memory?${params}`);
            const nodes = await res.json() as MemoryNode[];

            if (nodes.length === 0) {
                console.log(chalk.gray('\n  No memory nodes found.\n'));
                return;
            }

            console.log(chalk.cyan(`\n  Memory nodes (${nodes.length}):\n`));
            for (const node of nodes) {
                const date = new Date(node.createdAt).toLocaleDateString();
                console.log(`  ${chalk.yellow(node.id.slice(0, 8))} ${chalk.bold(node.title ?? node.id)}`);
                console.log(chalk.gray(`    type: ${node.nodeType} · importance: ${node.importance.toFixed(2)} · ${date}`));
                const preview = node.content.slice(0, 120).replace(/\n/g, ' ');
                console.log(chalk.gray(`    ${preview}${node.content.length > 120 ? '…' : ''}`));
                console.log();
            }
        } catch {
            console.log(chalk.yellow('\n  Agent is not running. Try: 0agent start\n'));
        }
    });

memoryCommand
    .command('show <id>')
    .description('Show the full content of a memory node')
    .action(async (id: string) => {
        const res = await fetch(`${BASE_URL}/api/memory/${id}`);
        if (!res.ok) {
            console.log(chalk.red(`\n  Node ${id} not found.\n`));
            return;
        }
        const node = await res.json() as MemoryNode;
        console.log(chalk.cyan(`\n  ${node.title ?? node.id}`));
        console.log(chalk.gray(`  type: ${node.nodeType} · importance: ${node.importance} · ${new Date(node.createdAt).toLocaleString()}\n`));
        console.log(node.content);
        console.log();
    });

memoryCommand
    .command('delete <id>')
    .description('Delete a memory node (Core Memory nodes are protected)')
    .action(async (id: string) => {
        const res = await fetch(`${BASE_URL}/api/memory/${id}`, { method: 'DELETE' });
        if (res.ok) {
            console.log(chalk.green(`\n  ✓ Node ${id} deleted.\n`));
        } else {
            const body = await res.json() as { error?: string };
            console.log(chalk.red(`\n  ✗ ${body.error ?? 'Could not delete node'}\n`));
        }
    });
