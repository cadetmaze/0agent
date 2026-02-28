-- ===========================================================================
-- Only Reason — 0 Agent
-- Complete Backend Setup Script (v1.2.0)
--
-- This script prepares a PostgreSQL database for the 0agent runtime.
-- It is designed to be idempotent: safe to run multiple times.
--
-- TARGET: PostgreSQL 15+ (Required for JSONB performance & pgvector compatibility)
-- ===========================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. EXTENSIONS & SCHEMA
-- ─────────────────────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "vector";

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. UTILITY FUNCTIONS
-- ─────────────────────────────────────────────────────────────────────────────

-- Standard trigger function to auto-update 'updated_at' columns.
CREATE OR REPLACE FUNCTION handle_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. CORE IDENTITY TABLES
-- ─────────────────────────────────────────────────────────────────────────────

-- Companies — the top-level tenant.
CREATE TABLE IF NOT EXISTS companies (
    id                   uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    name                 text NOT NULL,
    owner_id             uuid,
    optimization_mode    text NOT NULL DEFAULT 'balanced'
                         CHECK (optimization_mode IN ('quality', 'cost', 'balanced', 'speed')),
    optimization_config  jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now()
);

-- Experts — specialized judgment definitions.
CREATE TABLE IF NOT EXISTS experts (
    id                      uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    name                    text NOT NULL,
    domain                  text NOT NULL,
    bio                     text DEFAULT '',
    category                text DEFAULT '',
    training_version_hash   text,
    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now()
);

-- Agents — running instances for a company.
CREATE TABLE IF NOT EXISTS agents (
    id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    expert_id   uuid NOT NULL REFERENCES experts(id) ON DELETE CASCADE,
    role        text NOT NULL,
    status      text NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'inactive')),
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agents_company ON agents(company_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. MEMORY & JUDGMENT
-- ─────────────────────────────────────────────────────────────────────────────

-- Core Memory — Encoded judgment (Expert Identity).
CREATE TABLE IF NOT EXISTS core_memory (
    id                  uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    agent_id            uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    expert_id           uuid NOT NULL REFERENCES experts(id) ON DELETE CASCADE,
    training_version    text NOT NULL,
    judgment_json       jsonb NOT NULL DEFAULT '{}'::jsonb,
    hard_constraints    jsonb NOT NULL DEFAULT '[]'::jsonb,
    escalation_triggers jsonb NOT NULL DEFAULT '[]'::jsonb,
    confidence_map      jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_at          timestamptz NOT NULL DEFAULT now(),
    locked_at           timestamptz
);

-- Episodic Memory — Past session records (Legacy/Non-vector).
-- Note: Modern episodic retrieval uses semantic_memory.
CREATE TABLE IF NOT EXISTS episodic_memory (
    id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    agent_id    uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    session_id  uuid NOT NULL,
    summary     text NOT NULL,
    outcome     text DEFAULT '',
    sentiment   float DEFAULT 0.0,
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- Semantic Memory — Vector embeddings for similarity search (Transcripts, corrections, etc.)
CREATE TABLE IF NOT EXISTS semantic_memory (
    id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    agent_id    uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    content     text NOT NULL,
    embedding   vector(1536),
    metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
    owner       text NOT NULL DEFAULT 'company'
                CHECK (owner IN ('expert', 'company')),
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_semantic_memory_agent_owner ON semantic_memory(agent_id, owner);
CREATE INDEX IF NOT EXISTS idx_semantic_memory_embedding
    ON semantic_memory USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- Working Context — Short-term agent state.
CREATE TABLE IF NOT EXISTS working_context (
    id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    agent_id    uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    context_key text NOT NULL,
    value       jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_working_context_unique ON working_context(agent_id, context_key);

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. KNOWLEDGE GRAPH
-- ─────────────────────────────────────────────────────────────────────────────

-- Knowledge Graph Nodes — Obsidian-style node graph with provenance.
CREATE TABLE IF NOT EXISTS kg_nodes (
    id                      uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id              uuid REFERENCES companies(id) ON DELETE CASCADE, -- null for 'expert' owned global nodes
    agent_id                uuid REFERENCES agents(id) ON DELETE SET NULL,

    -- Ownership boundary
    owner                   text NOT NULL DEFAULT 'company'
                            CHECK (owner IN ('expert', 'company')),

    -- Classification
    node_type               text NOT NULL DEFAULT 'fact'
                            CHECK (node_type IN ('fact', 'insight', 'procedure', 'decision', 'episode', 'blink')),
    scope                   text NOT NULL DEFAULT 'agent'
                            CHECK (scope IN ('agent', 'team', 'org')),

    -- Content
    title                   text NOT NULL,
    content                 text NOT NULL,
    properties              jsonb NOT NULL DEFAULT '{}'::jsonb, -- Structured data for specific node types
    token_count             int NOT NULL DEFAULT 0,

    -- Provenance
    emerged_from_task_id    uuid,
    emerged_from_session    text,
    emerged_at              timestamptz NOT NULL DEFAULT now(),
    emerged_context         jsonb,

    -- Continuation chain
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
    valid_until             timestamptz,
    archived                boolean NOT NULL DEFAULT false,
    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_kg_nodes_company_owner ON kg_nodes(company_id, owner) WHERE archived = false;
CREATE INDEX IF NOT EXISTS idx_kg_nodes_agent_owner ON kg_nodes(agent_id, owner) WHERE archived = false;
CREATE INDEX IF NOT EXISTS idx_kg_nodes_embedding ON kg_nodes USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

CREATE TABLE IF NOT EXISTS kg_edges (
    id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    source_id       uuid NOT NULL REFERENCES kg_nodes(id) ON DELETE CASCADE,
    target_id       uuid NOT NULL REFERENCES kg_nodes(id) ON DELETE CASCADE,
    relationship    text NOT NULL
                    CHECK (relationship IN ('caused', 'supports', 'contradicts', 'continues', 'references', 'derived_from')),
    strength        float NOT NULL DEFAULT 0.5
                    CHECK (strength >= 0 AND strength <= 1),
    properties      jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at      timestamptz NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. TASKS & SESSIONS
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sessions (
    id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id      uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    agent_id        uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    user_id         text,
    platform        text CHECK (platform IN ('telegram', 'slack', 'api', 'internal')),
    status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
    created_at      timestamptz NOT NULL DEFAULT now(),
    closed_at       timestamptz
);

CREATE TABLE IF NOT EXISTS tasks (
    id             uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    session_id     uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    company_id     uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    agent_id       uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    spec           text NOT NULL,
    classification text CHECK (classification IN ('fast', 'standard', 'judgment_heavy', 'sensitive')),
    status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed')),
    result         jsonb,
    error          text,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. REINFORCEMENT & POLICY
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS adaptive_policy_store (
    id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    agent_id    uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    task_type   text NOT NULL CHECK (task_type IN ('fast', 'standard', 'judgment_heavy', 'sensitive')),
    version     integer NOT NULL DEFAULT 1,
    params      jsonb NOT NULL DEFAULT '{}'::jsonb,
    is_active   boolean NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- Append-only audit log
CREATE TABLE IF NOT EXISTS adaptive_audit_log (
    id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id      uuid NOT NULL,
    agent_id        uuid NOT NULL,
    task_id         uuid,
    reward_vector   jsonb NOT NULL,
    params_before   jsonb NOT NULL,
    params_after    jsonb NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE RULE no_update_adaptive_audit AS ON UPDATE TO adaptive_audit_log DO INSTEAD NOTHING;
CREATE RULE no_delete_adaptive_audit AS ON DELETE TO adaptive_audit_log DO INSTEAD NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. TRIGGERS & POLICES (SUPABASE COMPATIBILITY)
-- ─────────────────────────────────────────────────────────────────────────────

-- Apply updated_at to all relevant tables
DO $$
DECLARE
    t text;
BEGIN
    FOR t IN 
        SELECT table_name FROM information_schema.tables 
        WHERE table_schema = 'public' 
          AND column_name = 'updated_at'
          AND table_type = 'BASE TABLE'
    LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS trigger_updated_at ON %I', t);
        EXECUTE format('CREATE TRIGGER trigger_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION handle_updated_at()', t);
    END LOOP;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 9. SETUP COMPLETE
-- ─────────────────────────────────────────────────────────────────────────────

COMMENT ON TABLE agents IS 'Expert instances. Use status=''inactive'' to temporarily disable.';
COMMENT ON TABLE kg_nodes IS 'Core Knowledge Graph nodes with vector embeddings.';
COMMENT ON TABLE tasks IS 'Central task registry. Monitored by the BullMQ runtime.';
