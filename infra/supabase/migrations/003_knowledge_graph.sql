-- 003_knowledge_graph.sql
-- Knowledge Graph Memory — Obsidian-style node graph with provenance.
-- Every node tracks: where it emerged from, when, and what context created it.
-- Nodes are capped at 30,000 tokens; overflow creates a continuation chain.

-- ============================================================
-- Knowledge Graph Nodes
-- ============================================================

CREATE TABLE IF NOT EXISTS kg_nodes (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id              uuid NOT NULL,
    agent_id                uuid,                   -- null = org-scoped node

    -- Classification
    node_type               text NOT NULL           -- fact | insight | procedure | decision | episode | blink
        CHECK (node_type IN ('fact', 'insight', 'procedure', 'decision', 'episode', 'blink')),
    scope                   text NOT NULL DEFAULT 'agent'
        CHECK (scope IN ('agent', 'team', 'org')),

    -- Content
    title                   text NOT NULL,
    content                 text NOT NULL,
    token_count             int NOT NULL DEFAULT 0,

    -- Provenance (required on every node — where, when, and what context created this)
    emerged_from_task_id    uuid,                   -- task that produced this node
    emerged_from_session    text,                   -- session/job identifier
    emerged_at              timestamptz NOT NULL DEFAULT now(),
    emerged_context         jsonb,                  -- snapshot: optimizationMode, confidenceScore, taskSpec

    -- Continuation chain (for nodes that exceed 30k token cap)
    continues_node_id       uuid REFERENCES kg_nodes(id) ON DELETE SET NULL,
    is_continuation         boolean NOT NULL DEFAULT false,

    -- Retrieval
    embedding               vector(1536),
    tags                    text[] DEFAULT '{}',
    importance              float NOT NULL DEFAULT 0.5
        CHECK (importance >= 0 AND importance <= 1),
    access_count            int NOT NULL DEFAULT 0,
    last_accessed_at        timestamptz,

    -- Lifecycle
    valid_until             timestamptz,            -- null = permanent
    archived                boolean NOT NULL DEFAULT false,
    created_at              timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- Knowledge Graph Edges
-- ============================================================

CREATE TABLE IF NOT EXISTS kg_edges (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    from_node_id    uuid NOT NULL REFERENCES kg_nodes(id) ON DELETE CASCADE,
    to_node_id      uuid NOT NULL REFERENCES kg_nodes(id) ON DELETE CASCADE,
    relation        text NOT NULL
        CHECK (relation IN ('caused', 'supports', 'contradicts', 'continues', 'references', 'derived_from')),
    strength        float NOT NULL DEFAULT 0.5
        CHECK (strength >= 0 AND strength <= 1),
    created_at      timestamptz NOT NULL DEFAULT now(),

    UNIQUE(from_node_id, to_node_id, relation)
);

-- ============================================================
-- Blink Cycles
-- ============================================================

CREATE TABLE IF NOT EXISTS blink_cycles (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id      uuid NOT NULL,
    agent_id        uuid NOT NULL,
    task_id         uuid,

    trigger         text NOT NULL
        CHECK (trigger IN ('task_count', 'token_threshold', 'time_elapsed', 'cognitive_load', 'circuit_breaker')),

    -- Blink state (three questions)
    what_matters    text NOT NULL,
    what_decided    text[] NOT NULL DEFAULT '{}',
    what_doing      text NOT NULL,
    commitments     text[] NOT NULL DEFAULT '{}',
    noise_released  text[] NOT NULL DEFAULT '{}',

    -- Cognitive indicators
    cognitive_load  text NOT NULL DEFAULT 'low'
        CHECK (cognitive_load IN ('low', 'medium', 'high')),
    drift_risk      float NOT NULL DEFAULT 0.0
        CHECK (drift_risk >= 0 AND drift_risk <= 1),

    -- Metrics
    tokens_before   int NOT NULL DEFAULT 0,
    tokens_after    int NOT NULL DEFAULT 0,
    nodes_archived  int NOT NULL DEFAULT 0,

    created_at      timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- Indexes
-- ============================================================

-- pgvector HNSW for fast similarity search
CREATE INDEX IF NOT EXISTS idx_kg_nodes_embedding
    ON kg_nodes USING hnsw (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS idx_kg_nodes_company_type
    ON kg_nodes(company_id, node_type, archived)
    WHERE archived = false;

CREATE INDEX IF NOT EXISTS idx_kg_nodes_agent
    ON kg_nodes(agent_id, company_id, node_type)
    WHERE archived = false;

CREATE INDEX IF NOT EXISTS idx_kg_nodes_task
    ON kg_nodes(emerged_from_task_id)
    WHERE emerged_from_task_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_kg_nodes_continuation
    ON kg_nodes(continues_node_id)
    WHERE is_continuation = true;

CREATE INDEX IF NOT EXISTS idx_kg_edges_from
    ON kg_edges(from_node_id, relation);

CREATE INDEX IF NOT EXISTS idx_kg_edges_to
    ON kg_edges(to_node_id, relation);

CREATE INDEX IF NOT EXISTS idx_blink_cycles_agent
    ON blink_cycles(agent_id, company_id, created_at DESC);
