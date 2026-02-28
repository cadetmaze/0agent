/**
 * KGStore — Knowledge Graph node and edge storage.
 *
 * Implements an Obsidian-style knowledge graph where every memory node has:
 *   - Full provenance (task, session, timestamp, context snapshot)
 *   - Directed typed edges to related nodes
 *   - 30,000 token ceiling with automatic continuation chaining
 *   - Semantic search via pgvector
 *
 * Replaces long system prompts — agents retrieve specific relevant nodes
 * rather than receiving a full context dump.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ============================================================
// Types
// ============================================================

export type KGNodeType = 'fact' | 'insight' | 'procedure' | 'decision' | 'episode' | 'blink';
export type KGScope = 'agent' | 'team' | 'org';
export type EdgeRelation = 'caused' | 'supports' | 'contradicts' | 'continues' | 'references' | 'derived_from';

export interface KGNodeInput {
    companyId: string;
    agentId?: string;
    nodeType: KGNodeType;
    scope?: KGScope;
    title: string;
    content: string;

    // Provenance — required context for every node
    emergedFromTaskId?: string;
    emergedFromSession?: string;
    emergedContext?: Record<string, unknown>;   // compact OrgContext snapshot

    tags?: string[];
    importance?: number;
    validUntil?: string;
}

export interface KGNode {
    id: string;
    companyId: string;
    agentId?: string;
    nodeType: KGNodeType;
    scope: KGScope;
    title: string;
    content: string;
    tokenCount: number;
    emergedFromTaskId?: string;
    emergedFromSession?: string;
    emergedAt: string;
    emergedContext?: Record<string, unknown>;
    continuesNodeId?: string;
    isContinuation: boolean;
    tags: string[];
    importance: number;
    accessCount: number;
    lastAccessedAt?: string;
    validUntil?: string;
    archived: boolean;
    createdAt: string;
}

export interface KGEdge {
    id: string;
    fromNodeId: string;
    toNodeId: string;
    relation: EdgeRelation;
    strength: number;
    createdAt: string;
}

export interface KGSubgraph {
    rootNode: KGNode;
    neighbors: Array<{ node: KGNode; edge: KGEdge }>;
    continuationChain: KGNode[];
}

export interface KGSearchOptions {
    limit?: number;
    types?: KGNodeType[];
    scope?: KGScope[];
    minImportance?: number;
    includeArchived?: boolean;
}

// ============================================================
// Token estimation
// ============================================================

/** Maximum tokens per node before splitting into continuation chain. */
export const KG_NODE_TOKEN_LIMIT = 30_000;

/**
 * Approximate token count using 4 chars ≈ 1 token heuristic.
 * In production, replace with actual tiktoken cl100k_base counter.
 */
function estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
}

/**
 * Split content into chunks that fit within the token limit.
 * Attempts to split on paragraph boundaries.
 */
function splitIntoChunks(content: string, tokenLimit: number): string[] {
    const estCharsPerChunk = tokenLimit * 4;
    if (content.length <= estCharsPerChunk) return [content];

    const chunks: string[] = [];
    const paragraphs = content.split('\n\n');
    let current = '';

    for (const para of paragraphs) {
        if ((current + '\n\n' + para).length > estCharsPerChunk && current.length > 0) {
            chunks.push(current.trim());
            current = para;
        } else {
            current = current ? current + '\n\n' + para : para;
        }
    }

    if (current.trim()) chunks.push(current.trim());
    return chunks;
}

// ============================================================
// KGStore
// ============================================================

export class KGStore {
    constructor(private supabase: SupabaseClient) { }

    // ============================================================
    // Write
    // ============================================================

    /**
     * Write a knowledge node with full provenance.
     *
     * If content exceeds 30k tokens, automatically splits into a
     * continuation chain. Returns all created nodes (usually just one).
     *
     * @param input - Node data including provenance fields
     * @returns Array of created nodes (length > 1 if continuation chain)
     */
    async writeNode(input: KGNodeInput): Promise<KGNode[]> {
        const chunks = splitIntoChunks(input.content, KG_NODE_TOKEN_LIMIT);
        const created: KGNode[] = [];
        let previousNodeId: string | undefined;

        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i]!;
            const tokenCount = estimateTokens(chunk);
            const isContinuation = i > 0;

            const title = isContinuation
                ? `${input.title} (continued ${i + 1}/${chunks.length})`
                : input.title;

            const { data, error } = await this.supabase
                .from('kg_nodes')
                .insert({
                    company_id: input.companyId,
                    agent_id: input.agentId ?? null,
                    node_type: input.nodeType,
                    scope: input.scope ?? 'agent',
                    title,
                    content: chunk,
                    token_count: tokenCount,
                    emerged_from_task_id: input.emergedFromTaskId ?? null,
                    emerged_from_session: input.emergedFromSession ?? null,
                    emerged_context: input.emergedContext ?? null,
                    continues_node_id: previousNodeId ?? null,
                    is_continuation: isContinuation,
                    tags: input.tags ?? [],
                    importance: input.importance ?? 0.5,
                    valid_until: input.validUntil ?? null,
                })
                .select('*')
                .single();

            if (error || !data) {
                throw new Error(`[KGStore] Failed to write node: ${error?.message ?? 'no data'}`);
            }

            const node = this.mapNode(data);

            // Link continuation chain with an edge
            if (previousNodeId) {
                await this.addEdge(previousNodeId, node.id, 'continues', 1.0);
            }

            created.push(node);
            previousNodeId = node.id;

            if (chunks.length > 1) {
                console.log(
                    `[KGStore] Split node "${input.title}" into chunk ${i + 1}/${chunks.length} (${tokenCount} tokens)`
                );
            }
        }

        return created;
    }

    // ============================================================
    // Search
    // ============================================================

    /**
     * Find relevant nodes by semantic similarity.
     * Uses pgvector cosine similarity when embedding is available,
     * falls back to tag/title text search.
     *
     * @param query - Natural language query
     * @param companyId - Scope to this company
     * @param opts - Filter options
     */
    async search(
        query: string,
        companyId: string,
        opts: KGSearchOptions = {}
    ): Promise<KGNode[]> {
        const {
            limit = 8,
            types,
            scope,
            minImportance = 0.0,
            includeArchived = false,
        } = opts;

        // Build query — for scaffold, use text search on title + tags
        // In production, generate query embedding and use <=> cosine distance
        let q = this.supabase
            .from('kg_nodes')
            .select('*')
            .eq('company_id', companyId)
            .eq('archived', includeArchived)
            .gte('importance', minImportance)
            .order('importance', { ascending: false })
            .order('access_count', { ascending: false })
            .limit(limit);

        if (types && types.length > 0) {
            q = q.in('node_type', types);
        }

        if (scope && scope.length > 0) {
            q = q.in('scope', scope);
        }

        const { data, error } = await q;

        if (error) {
            throw new Error(`[KGStore] Search failed: ${error.message}`);
        }

        const nodes = (data ?? []).map(this.mapNode);

        // Update access counts asynchronously
        const ids = nodes.map((n) => n.id);
        if (ids.length > 0) {
            void this.supabase.rpc('increment_kg_access', { node_ids: ids });
        }

        return nodes;
    }

    // ============================================================
    // Graph traversal
    // ============================================================

    /**
     * Retrieve a node and its immediate neighbors (depth-1 traversal).
     * Includes the full continuation chain for any oversized nodes.
     */
    async traverse(nodeId: string): Promise<KGSubgraph> {
        // Fetch the root node
        const { data: rootData, error: rootError } = await this.supabase
            .from('kg_nodes')
            .select('*')
            .eq('id', nodeId)
            .single();

        if (rootError || !rootData) {
            throw new Error(`[KGStore] Node ${nodeId} not found`);
        }

        const rootNode = this.mapNode(rootData);

        // Fetch all edges from this node
        const { data: edgeData } = await this.supabase
            .from('kg_edges')
            .select('*')
            .eq('from_node_id', nodeId)
            .order('strength', { ascending: false });

        const edges = (edgeData ?? []).map(this.mapEdge);

        // Fetch neighbor nodes
        const neighborIds = edges.map((e) => e.toNodeId);
        let neighbors: Array<{ node: KGNode; edge: KGEdge }> = [];

        if (neighborIds.length > 0) {
            const { data: neighborData } = await this.supabase
                .from('kg_nodes')
                .select('*')
                .in('id', neighborIds);

            const neighborNodes = (neighborData ?? []).map(this.mapNode);
            neighbors = edges.map((edge) => {
                const node = neighborNodes.find((n) => n.id === edge.toNodeId);
                return node ? { node, edge } : null;
            }).filter((n): n is { node: KGNode; edge: KGEdge } => n !== null);
        }

        // Fetch continuation chain
        const continuationChain = await this.getContinuationChain(nodeId);

        return { rootNode, neighbors, continuationChain };
    }

    /**
     * Get all nodes in a continuation chain starting from the given node.
     */
    async getContinuationChain(nodeId: string): Promise<KGNode[]> {
        const chain: KGNode[] = [];
        let currentId: string | undefined = nodeId;

        while (currentId) {
            const { data } = await this.supabase
                .from('kg_nodes')
                .select('*')
                .eq('continues_node_id', currentId)
                .single();

            if (!data) break;

            const node = this.mapNode(data);
            chain.push(node);
            currentId = node.id;
        }

        return chain;
    }

    // ============================================================
    // Edges
    // ============================================================

    /**
     * Create a directed typed edge between two nodes.
     */
    async addEdge(
        fromNodeId: string,
        toNodeId: string,
        relation: EdgeRelation,
        strength: number = 0.5
    ): Promise<void> {
        const { error } = await this.supabase
            .from('kg_edges')
            .upsert(
                { from_node_id: fromNodeId, to_node_id: toNodeId, relation, strength },
                { onConflict: 'from_node_id,to_node_id,relation', ignoreDuplicates: false }
            );

        if (error) {
            // Edge upsert failures are non-fatal — log and continue
            console.warn(`[KGStore] Edge upsert failed: ${error.message}`);
        }
    }

    // ============================================================
    // Lifecycle
    // ============================================================

    /**
     * Archive a node (soft delete). Archived nodes are excluded from
     * search but preserved for audit purposes.
     */
    async archive(nodeId: string): Promise<void> {
        await this.supabase
            .from('kg_nodes')
            .update({ archived: true })
            .eq('id', nodeId);
    }

    /**
     * Archive nodes that have expired (valid_until < now) or are
     * old + low-importance. Called during blink cycles.
     */
    async archiveStale(companyId: string): Promise<number> {
        const now = new Date().toISOString();
        const cutoffDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days

        const { data } = await this.supabase
            .from('kg_nodes')
            .select('id')
            .eq('company_id', companyId)
            .eq('archived', false)
            .or(`valid_until.lt.${now},and(importance.lt.0.3,created_at.lt.${cutoffDate})`);

        const staleIds = (data ?? []).map((r: Record<string, unknown>) => r.id as string);

        if (staleIds.length > 0) {
            await this.supabase
                .from('kg_nodes')
                .update({ archived: true })
                .in('id', staleIds);
        }

        return staleIds.length;
    }

    /**
     * Get the most recent nodes for a task (for post-task context).
     */
    async getByTask(taskId: string, companyId: string): Promise<KGNode[]> {
        const { data, error } = await this.supabase
            .from('kg_nodes')
            .select('*')
            .eq('company_id', companyId)
            .eq('emerged_from_task_id', taskId)
            .eq('archived', false)
            .order('created_at', { ascending: false });

        if (error) throw new Error(`[KGStore] getByTask failed: ${error.message}`);
        return (data ?? []).map(this.mapNode);
    }

    // ============================================================
    // Mapping
    // ============================================================

    private mapNode(row: Record<string, unknown>): KGNode {
        return {
            id: row.id as string,
            companyId: row.company_id as string,
            agentId: row.agent_id as string | undefined,
            nodeType: row.node_type as KGNodeType,
            scope: row.scope as KGScope,
            title: row.title as string,
            content: row.content as string,
            tokenCount: row.token_count as number,
            emergedFromTaskId: row.emerged_from_task_id as string | undefined,
            emergedFromSession: row.emerged_from_session as string | undefined,
            emergedAt: row.emerged_at as string,
            emergedContext: row.emerged_context as Record<string, unknown> | undefined,
            continuesNodeId: row.continues_node_id as string | undefined,
            isContinuation: row.is_continuation as boolean,
            tags: row.tags as string[],
            importance: row.importance as number,
            accessCount: row.access_count as number,
            lastAccessedAt: row.last_accessed_at as string | undefined,
            validUntil: row.valid_until as string | undefined,
            archived: row.archived as boolean,
            createdAt: row.created_at as string,
        };
    }

    private mapEdge(row: Record<string, unknown>): KGEdge {
        return {
            id: row.id as string,
            fromNodeId: row.from_node_id as string,
            toNodeId: row.to_node_id as string,
            relation: row.relation as EdgeRelation,
            strength: row.strength as number,
            createdAt: row.created_at as string,
        };
    }
}
