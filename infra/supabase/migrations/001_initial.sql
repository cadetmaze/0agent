-- Only Reason 0 Agent — Initial Schema
-- All primary keys are UUIDs. All timestamps are timestamptz.

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgvector";

-- ============================================================
-- COMPANIES
-- ============================================================
CREATE TABLE companies (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name        TEXT NOT NULL,
    owner_id    UUID,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- EXPERTS
-- ============================================================
CREATE TABLE experts (
    id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name                    TEXT NOT NULL,
    domain                  TEXT NOT NULL,
    training_version_hash   TEXT,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- AGENTS
-- ============================================================
CREATE TABLE agents (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    expert_id   UUID NOT NULL REFERENCES experts(id) ON DELETE CASCADE,
    role        TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_agents_company ON agents(company_id);
CREATE INDEX idx_agents_expert ON agents(expert_id);

-- ============================================================
-- CORE MEMORY
-- Constraint: only the Python training service may write here.
-- Agent processes must NOT update this table.
-- ============================================================
CREATE TABLE core_memory (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    agent_id            UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    expert_id           UUID NOT NULL REFERENCES experts(id) ON DELETE CASCADE,
    training_version    TEXT NOT NULL,
    judgment_json       JSONB NOT NULL DEFAULT '{}'::jsonb,
    hard_constraints    JSONB NOT NULL DEFAULT '[]'::jsonb,
    escalation_triggers JSONB NOT NULL DEFAULT '[]'::jsonb,
    confidence_map      JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    locked_at           TIMESTAMPTZ
);

CREATE INDEX idx_core_memory_agent ON core_memory(agent_id);

-- Add a comment to enforce the contract: only training service writes here
COMMENT ON TABLE core_memory IS
    'Only the Python training service may INSERT/UPDATE rows. '
    'Agent runtime processes must treat this table as read-only.';

-- ============================================================
-- WORKING MEMORY (session-scoped, ephemeral)
-- ============================================================
CREATE TABLE working_memory (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    agent_id        UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    task_id         UUID,
    context_json    JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at      TIMESTAMPTZ
);

CREATE INDEX idx_working_memory_agent ON working_memory(agent_id);
CREATE INDEX idx_working_memory_task ON working_memory(task_id);

-- ============================================================
-- EPISODIC MEMORY (persistent past sessions)
-- ============================================================
CREATE TABLE episodic_memory (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    agent_id    UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    session_id  UUID NOT NULL,
    summary     TEXT NOT NULL,
    outcome     TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    sentiment   FLOAT
);

CREATE INDEX idx_episodic_memory_agent ON episodic_memory(agent_id);
CREATE INDEX idx_episodic_memory_session ON episodic_memory(session_id);

-- ============================================================
-- SEMANTIC MEMORY (vector embeddings for similarity search)
-- ============================================================
CREATE TABLE semantic_memory (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    agent_id    UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    content     TEXT NOT NULL,
    embedding   vector(1536),
    metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_semantic_memory_agent ON semantic_memory(agent_id);

-- IVFFlat index for fast cosine similarity search
-- NOTE: Requires at least some rows to exist before the index is useful.
-- In production, consider rebuilding this index periodically.
CREATE INDEX idx_semantic_memory_embedding
    ON semantic_memory
    USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 100);

-- ============================================================
-- ORG KNOWLEDGE GRAPH
-- ============================================================
CREATE TABLE org_knowledge_graph (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    entity_type     TEXT NOT NULL CHECK (entity_type IN ('person', 'project', 'decision', 'relationship')),
    entity_data     JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_org_graph_company ON org_knowledge_graph(company_id);
CREATE INDEX idx_org_graph_type ON org_knowledge_graph(entity_type);

-- ============================================================
-- TASKS
-- ============================================================
CREATE TABLE tasks (
    id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id              UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    agent_id                UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    spec                    JSONB NOT NULL DEFAULT '{}'::jsonb,
    status                  TEXT NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending', 'in_progress', 'completed', 'failed', 'halted_for_approval')),
    estimated_cost_tokens   INTEGER,
    estimated_cost_dollars  NUMERIC(12,6),
    actual_cost_dollars     NUMERIC(12,6),
    dependencies            UUID[] DEFAULT '{}',
    idempotency_key         TEXT UNIQUE,
    outcome_pointer         TEXT,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_tasks_company ON tasks(company_id);
CREATE INDEX idx_tasks_agent ON tasks(agent_id);
CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_idempotency ON tasks(idempotency_key);

-- ============================================================
-- TASK CONTRACTS (agent-to-agent handoffs)
-- ============================================================
CREATE TABLE task_contracts (
    id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    source_agent_id         UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    target_agent_id         UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    input_schema            JSONB NOT NULL DEFAULT '{}'::jsonb,
    output_schema           JSONB NOT NULL DEFAULT '{}'::jsonb,
    acceptance_criteria     JSONB NOT NULL DEFAULT '[]'::jsonb,
    trust_score_at_time     FLOAT,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_contracts_source ON task_contracts(source_agent_id);
CREATE INDEX idx_contracts_target ON task_contracts(target_agent_id);

-- ============================================================
-- TELEMETRY EVENTS (append-only)
-- ============================================================
CREATE TABLE telemetry_events (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id          UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    agent_id            UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    task_id             UUID,
    event_type          TEXT NOT NULL,
    payload             JSONB NOT NULL DEFAULT '{}'::jsonb,
    cost_tokens         INTEGER,
    cost_dollars        NUMERIC(12,6),
    latency_ms          INTEGER,
    success             BOOLEAN,
    confidence_score    FLOAT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_telemetry_company ON telemetry_events(company_id);
CREATE INDEX idx_telemetry_agent ON telemetry_events(agent_id);
CREATE INDEX idx_telemetry_task ON telemetry_events(task_id);
CREATE INDEX idx_telemetry_type ON telemetry_events(event_type);

-- Trigger: prevent UPDATE and DELETE on telemetry_events (append-only)
CREATE OR REPLACE FUNCTION prevent_telemetry_modification()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'telemetry_events is append-only. UPDATE and DELETE are not allowed.';
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_telemetry_no_update
    BEFORE UPDATE ON telemetry_events
    FOR EACH ROW EXECUTE FUNCTION prevent_telemetry_modification();

CREATE TRIGGER trg_telemetry_no_delete
    BEFORE DELETE ON telemetry_events
    FOR EACH ROW EXECUTE FUNCTION prevent_telemetry_modification();

-- ============================================================
-- APL MEASUREMENTS
-- ============================================================
CREATE TABLE apl_measurements (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    agent_id        UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    kpi_name        TEXT NOT NULL,
    baseline_value  FLOAT NOT NULL,
    observed_value  FLOAT NOT NULL,
    delta           FLOAT NOT NULL,
    confidence      FLOAT NOT NULL,
    window_start    TIMESTAMPTZ NOT NULL,
    window_end      TIMESTAMPTZ NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_apl_company ON apl_measurements(company_id);
CREATE INDEX idx_apl_agent ON apl_measurements(agent_id);
CREATE INDEX idx_apl_kpi ON apl_measurements(kpi_name);

-- ============================================================
-- TRUST REGISTRY
-- ============================================================
CREATE TABLE trust_registry (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    agent_id            UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    apl_score           FLOAT NOT NULL DEFAULT 0.0,
    transaction_count   INTEGER NOT NULL DEFAULT 0,
    last_updated        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_trust_agent ON trust_registry(agent_id);

-- ============================================================
-- CREDENTIALS (Key Proxy only)
-- Row-Level Security: only the Key Proxy service role can read.
-- ============================================================
CREATE TABLE credentials (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    adapter_name    TEXT NOT NULL,
    encrypted_value TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_credentials_company ON credentials(company_id);
CREATE INDEX idx_credentials_adapter ON credentials(adapter_name);

-- Enable RLS on credentials
ALTER TABLE credentials ENABLE ROW LEVEL SECURITY;

-- Policy: only the 'key_proxy' role can SELECT from credentials
-- In production, create the key_proxy role and grant SELECT only to it.
-- For scaffold purposes, this policy blocks all access by default.
CREATE POLICY credentials_key_proxy_read
    ON credentials
    FOR SELECT
    USING (current_setting('app.service_role', true) = 'key_proxy');

COMMENT ON TABLE credentials IS
    'Encrypted credentials. Only readable by the Key Proxy service. '
    'Never expose raw credential values in logs, task specs, or telemetry.';

-- ============================================================
-- APPROVAL QUEUE
-- ============================================================
CREATE TABLE approval_queue (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    task_id     UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    agent_id    UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    reason      TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'approved', 'rejected')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at TIMESTAMPTZ,
    resolved_by UUID
);

CREATE INDEX idx_approval_task ON approval_queue(task_id);
CREATE INDEX idx_approval_agent ON approval_queue(agent_id);
CREATE INDEX idx_approval_status ON approval_queue(status);
