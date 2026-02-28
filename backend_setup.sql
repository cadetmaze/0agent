-- ===========================================================================
-- Only Reason — 0 Agent
-- Complete Backend Setup Script
--
-- Run this against a fresh Postgres 15+ database with the pgvector extension
-- available. Supabase users: paste directly into the SQL editor or run via
-- the Supabase CLI. Bare Postgres users: see the setup guide at the bottom.
--
-- ORDER OF EXECUTION (do not reorder):
--   1. Extensions
--   2. Core tables (companies → experts → agents → memory)
--   3. Task & coordination tables
--   4. Telemetry & APL tables
--   5. Security & approval tables
--   6. Domain extensions (decisions, context, seats, royalties, capabilities)
--   7. Knowledge graph memory (kg_nodes, kg_edges, blink_cycles)
--   8. Reinforcement layer (adaptive_policy_store, adaptive_audit_log)
-- ===========================================================================


-- ===========================================================================
-- SECTION 1: EXTENSIONS
-- Requires: pg_vector installed on your Postgres instance.
-- Supabase: enabled by default.
-- Bare Postgres: install via `apt install postgresql-15-pgvector` or compile.
-- ===========================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "vector";


-- ===========================================================================
-- SECTION 2: CORE IDENTITY TABLES
-- ===========================================================================

-- Companies — the top-level org unit. Every agent belongs to a company.
CREATE TABLE IF NOT EXISTS companies (
    id                   uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    name                 text NOT NULL,
    owner_id             uuid,
    optimization_mode    text NOT NULL DEFAULT 'balanced'
                         CHECK (optimization_mode IN ('quality', 'cost', 'balanced', 'speed')),
    optimization_config  jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at           timestamptz NOT NULL DEFAULT now()
);

-- Experts — domain specialists whose judgment is encoded into agents.
CREATE TABLE IF NOT EXISTS experts (
    id                      uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    name                    text NOT NULL,
    domain                  text NOT NULL,
    bio                     text DEFAULT '',
    category                text DEFAULT '',
    training_version_hash   text,
    created_at              timestamptz NOT NULL DEFAULT now()
);

-- Agents — running instances of an expert's judgment inside a company.
CREATE TABLE IF NOT EXISTS agents (
    id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    expert_id   uuid NOT NULL REFERENCES experts(id) ON DELETE CASCADE,
    role        text NOT NULL,
    status      text NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'inactive')),
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agents_company ON agents(company_id);
CREATE INDEX IF NOT EXISTS idx_agents_expert  ON agents(expert_id);


-- ===========================================================================
-- SECTION 3: MEMORY TABLES
-- ===========================================================================

-- Core Memory — the expert's encoded judgment. READ-ONLY for the runtime.
-- Only the Python training service may INSERT/UPDATE here.
-- The runtime treats this as a configuration blob, never writes to it.
COMMENT ON TABLE companies IS 'Top-level org unit. All agent data is scoped to a company.';

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

CREATE INDEX IF NOT EXISTS idx_core_memory_agent ON core_memory(agent_id);

COMMENT ON TABLE core_memory IS
    'Only the Python training service may INSERT/UPDATE rows. '
    'The agent runtime is read-only here. Expert identity never changes during execution.';

-- Working Memory — task-scoped, ephemeral. Lives in Redis in production.
-- This table is the durable fallback if Redis is unavailable.
CREATE TABLE IF NOT EXISTS working_memory (
    id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    agent_id        uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    task_id         uuid,
    context_json    jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at      timestamptz NOT NULL DEFAULT now(),
    expires_at      timestamptz
);

CREATE INDEX IF NOT EXISTS idx_working_memory_agent ON working_memory(agent_id);
CREATE INDEX IF NOT EXISTS idx_working_memory_task  ON working_memory(task_id);

-- Episodic Memory — persistent log of past sessions and what the agent learned.
CREATE TABLE IF NOT EXISTS episodic_memory (
    id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    agent_id    uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    session_id  uuid NOT NULL,
    summary     text NOT NULL,
    outcome     text,
    sentiment   float,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_episodic_memory_agent   ON episodic_memory(agent_id);
CREATE INDEX IF NOT EXISTS idx_episodic_memory_session ON episodic_memory(session_id);

-- Semantic Memory — vector embeddings for meaning-based retrieval.
-- Requires pgvector. Dimension 1536 = OpenAI text-embedding-3-small.
CREATE TABLE IF NOT EXISTS semantic_memory (
    id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    agent_id    uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    content     text NOT NULL,
    embedding   vector(1536),
    metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_semantic_memory_agent ON semantic_memory(agent_id);

-- IVFFlat vector index. Requires rows to exist first to be useful.
-- In production, run: REINDEX INDEX idx_semantic_memory_embedding;
-- after initial data load.
CREATE INDEX IF NOT EXISTS idx_semantic_memory_embedding
    ON semantic_memory USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- Org Knowledge Graph — entities, projects, decisions within an org.
CREATE TABLE IF NOT EXISTS org_knowledge_graph (
    id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id      uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    entity_type     text NOT NULL
                    CHECK (entity_type IN (
                        'person', 'project', 'decision', 'relationship',
                        'product', 'customer', 'experiment', 'process'
                    )),
    entity_data     jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_org_graph_company ON org_knowledge_graph(company_id);
CREATE INDEX IF NOT EXISTS idx_org_graph_type    ON org_knowledge_graph(entity_type);


-- ===========================================================================
-- SECTION 4: TASK & COORDINATION TABLES
-- ===========================================================================

-- Tasks — the unit of work. Every agent action is a task.
CREATE TABLE IF NOT EXISTS tasks (
    id                      uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id              uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    agent_id                uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    spec                    jsonb NOT NULL DEFAULT '{}'::jsonb,
    status                  text NOT NULL DEFAULT 'pending'
                            CHECK (status IN (
                                'pending', 'in_progress', 'completed',
                                'failed', 'halted', 'halted_for_approval'
                            )),
    estimated_cost_tokens   integer,
    estimated_cost_dollars  numeric(12,6),
    actual_cost_dollars     numeric(12,6),
    dependencies            uuid[] DEFAULT '{}',
    idempotency_key         text UNIQUE,
    outcome_pointer         text,
    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tasks_company     ON tasks(company_id);
CREATE INDEX IF NOT EXISTS idx_tasks_agent       ON tasks(agent_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status      ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_idempotency ON tasks(idempotency_key);

-- Task Contracts — typed agent-to-agent handoff schemas.
-- Trust is scored by APL, not assumed. See trust_registry.
CREATE TABLE IF NOT EXISTS task_contracts (
    id                  uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    source_agent_id     uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    target_agent_id     uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    input_schema        jsonb NOT NULL DEFAULT '{}'::jsonb,
    output_schema       jsonb NOT NULL DEFAULT '{}'::jsonb,
    acceptance_criteria jsonb NOT NULL DEFAULT '[]'::jsonb,
    trust_score_at_time float,
    created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_contracts_source ON task_contracts(source_agent_id);
CREATE INDEX IF NOT EXISTS idx_contracts_target ON task_contracts(target_agent_id);


-- ===========================================================================
-- SECTION 5: TELEMETRY & APL TABLES
-- ===========================================================================

-- Telemetry Events — immutable append-only event stream.
-- Every model call, tool invocation, and decision is logged here.
-- The triggers below prevent UPDATE and DELETE.
CREATE TABLE IF NOT EXISTS telemetry_events (
    id               uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id       uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    agent_id         uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    task_id          uuid,
    event_type       text NOT NULL,
    payload          jsonb NOT NULL DEFAULT '{}'::jsonb,
    cost_tokens      integer,
    cost_dollars     numeric(12,6),
    latency_ms       integer,
    success          boolean,
    confidence_score float,
    created_at       timestamptz NOT NULL DEFAULT now()
);

-- Logs — human-readable system logs for the CLI tailing.
CREATE TABLE IF NOT EXISTS logs (
    id               uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    agent_id         uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    task_id          uuid,
    level            text NOT NULL DEFAULT 'info'
                     CHECK (level IN ('debug', 'info', 'warn', 'error')),
    message          text NOT NULL,
    metadata         jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_logs_agent ON logs(agent_id);
CREATE INDEX IF NOT EXISTS idx_logs_task  ON logs(task_id);
CREATE INDEX IF NOT EXISTS idx_logs_level ON logs(level);
CREATE INDEX IF NOT EXISTS idx_logs_created_at ON logs(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_telemetry_company ON telemetry_events(company_id);
CREATE INDEX IF NOT EXISTS idx_telemetry_agent   ON telemetry_events(agent_id);
CREATE INDEX IF NOT EXISTS idx_telemetry_task    ON telemetry_events(task_id);
CREATE INDEX IF NOT EXISTS idx_telemetry_type    ON telemetry_events(event_type);

-- Append-only enforcement
CREATE OR REPLACE FUNCTION prevent_telemetry_modification()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'telemetry_events is append-only. UPDATE and DELETE are not allowed.';
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_telemetry_no_update ON telemetry_events;
CREATE TRIGGER trg_telemetry_no_update
    BEFORE UPDATE ON telemetry_events
    FOR EACH ROW EXECUTE FUNCTION prevent_telemetry_modification();

DROP TRIGGER IF EXISTS trg_telemetry_no_delete ON telemetry_events;
CREATE TRIGGER trg_telemetry_no_delete
    BEFORE DELETE ON telemetry_events
    FOR EACH ROW EXECUTE FUNCTION prevent_telemetry_modification();

-- APL Measurements — outcome delta vs baseline, computed after outcome window closes.
CREATE TABLE IF NOT EXISTS apl_measurements (
    id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id      uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    agent_id        uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    kpi_name        text NOT NULL,
    baseline_value  float NOT NULL,
    observed_value  float NOT NULL,
    delta           float NOT NULL,
    confidence      float NOT NULL,
    window_start    timestamptz NOT NULL,
    window_end      timestamptz NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_apl_company ON apl_measurements(company_id);
CREATE INDEX IF NOT EXISTS idx_apl_agent   ON apl_measurements(agent_id);
CREATE INDEX IF NOT EXISTS idx_apl_kpi     ON apl_measurements(kpi_name);

-- APL Baselines — pre-agent KPI snapshots. Set before deployment.
CREATE TABLE IF NOT EXISTS apl_baselines (
    id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id      uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    kpi_name        text NOT NULL,
    baseline_value  float NOT NULL,
    measured_at     timestamptz NOT NULL DEFAULT now(),
    measured_by     uuid,
    notes           text DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_apl_baselines_company ON apl_baselines(company_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_apl_baselines_company_kpi ON apl_baselines(company_id, kpi_name);

-- Trust Registry — APL-derived trust scores per agent.
CREATE TABLE IF NOT EXISTS trust_registry (
    id                uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    agent_id          uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    apl_score         float NOT NULL DEFAULT 0.0,
    transaction_count integer NOT NULL DEFAULT 0,
    last_updated      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_trust_agent ON trust_registry(agent_id);


-- ===========================================================================
-- SECTION 6: SECURITY & APPROVAL TABLES
-- ===========================================================================

-- Credentials — encrypted. Only the Key Proxy service role may read.
-- In production: create a 'key_proxy' database role and grant SELECT only to it.
CREATE TABLE IF NOT EXISTS credentials (
    id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id      uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    adapter_name    text NOT NULL,
    encrypted_value text NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_credentials_company ON credentials(company_id);
CREATE INDEX IF NOT EXISTS idx_credentials_adapter ON credentials(adapter_name);

ALTER TABLE credentials ENABLE ROW LEVEL SECURITY;

-- Blocks all access by default. In production, grant SELECT to 'key_proxy' role:
--   CREATE ROLE key_proxy;
--   CREATE POLICY credentials_key_proxy_read ON credentials
--     FOR SELECT USING (current_setting('app.service_role', true) = 'key_proxy');
--   GRANT SELECT ON credentials TO key_proxy;
COMMENT ON TABLE credentials IS
    'Encrypted credentials. Only readable by the Key Proxy service. '
    'Never expose raw values in logs, telemetry, or task specs.';

-- Approval Queue — human-in-the-loop gate.
-- Configurable timeout: auto-reject or auto-approve-low-risk on expiry.
CREATE TABLE IF NOT EXISTS approval_queue (
    id                          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    task_id                     uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    agent_id                    uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    reason                      text NOT NULL,
    status                      text NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending', 'approved', 'rejected')),
    correction_content          text DEFAULT '',
    correction_incorporated     boolean DEFAULT false,
    created_at                  timestamptz NOT NULL DEFAULT now(),
    resolved_at                 timestamptz,
    resolved_by                 uuid
);

CREATE INDEX IF NOT EXISTS idx_approval_task   ON approval_queue(task_id);
CREATE INDEX IF NOT EXISTS idx_approval_agent  ON approval_queue(agent_id);
CREATE INDEX IF NOT EXISTS idx_approval_status ON approval_queue(status);


-- ===========================================================================
-- SECTION 7: DOMAIN EXTENSION TABLES
-- ===========================================================================

-- Decision Log — immutable log of every significant decision.
-- Outcome fields may be updated after creation. Nothing else.
CREATE TABLE IF NOT EXISTS decision_log (
    id                  uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id          uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    agent_id            uuid REFERENCES agents(id) ON DELETE SET NULL,
    seat_id             uuid,  -- FK added below after seats table exists
    decision_title      text NOT NULL,
    description         text NOT NULL DEFAULT '',
    rationale           text NOT NULL DEFAULT '',
    made_by             uuid NOT NULL,
    made_by_type        text NOT NULL CHECK (made_by_type IN ('agent', 'human')),
    outcome             text,
    outcome_recorded_at timestamptz,
    tags                text[] DEFAULT '{}',
    created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_decision_log_company  ON decision_log(company_id);
CREATE INDEX IF NOT EXISTS idx_decision_log_agent    ON decision_log(agent_id);
CREATE INDEX IF NOT EXISTS idx_decision_log_made_by  ON decision_log(made_by);

CREATE OR REPLACE FUNCTION prevent_decision_log_modification()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'decision_log is append-only. DELETE is not allowed.';
    END IF;
    IF TG_OP = 'UPDATE' THEN
        IF OLD.decision_title != NEW.decision_title
           OR OLD.description != NEW.description
           OR OLD.rationale != NEW.rationale
           OR OLD.made_by != NEW.made_by THEN
            RAISE EXCEPTION 'decision_log: only outcome fields may be updated after creation.';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_decision_log_protect ON decision_log;
CREATE TRIGGER trg_decision_log_protect
    BEFORE UPDATE OR DELETE ON decision_log
    FOR EACH ROW EXECUTE FUNCTION prevent_decision_log_modification();

-- Active Context — company-wide live state. Updated after every task.
CREATE TABLE IF NOT EXISTS active_context (
    id                  uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id          uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    priorities          jsonb NOT NULL DEFAULT '[]'::jsonb,
    in_flight_tasks     jsonb NOT NULL DEFAULT '[]'::jsonb,
    open_questions      jsonb NOT NULL DEFAULT '[]'::jsonb,
    active_experiments  jsonb NOT NULL DEFAULT '[]'::jsonb,
    updated_at          timestamptz NOT NULL DEFAULT now(),
    updated_by_agent    uuid REFERENCES agents(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_active_context_company ON active_context(company_id);

-- Seats — contestable roles within a company.
-- An agent holds a seat. Seats can be challenged when APL drops.
CREATE TABLE IF NOT EXISTS seats (
    id                       uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id               uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    role                     text NOT NULL,
    scope                    text NOT NULL DEFAULT '',
    current_agent_id         uuid REFERENCES agents(id) ON DELETE SET NULL,
    current_expert_id        uuid REFERENCES experts(id) ON DELETE SET NULL,
    apl_score                float NOT NULL DEFAULT 0.0,
    performance_window_days  integer NOT NULL DEFAULT 21,
    challenge_threshold      float NOT NULL DEFAULT 0.1,
    challenge_eligible_after timestamptz,
    status                   text NOT NULL DEFAULT 'open'
                             CHECK (status IN ('open', 'held', 'challenge_in_progress', 'frozen')),
    created_at               timestamptz NOT NULL DEFAULT now(),
    updated_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_seats_company ON seats(company_id);
CREATE INDEX IF NOT EXISTS idx_seats_agent   ON seats(current_agent_id);
CREATE INDEX IF NOT EXISTS idx_seats_expert  ON seats(current_expert_id);
CREATE INDEX IF NOT EXISTS idx_seats_role    ON seats(role);

-- Now that seats exists, add the FK from decision_log
ALTER TABLE decision_log
    ADD CONSTRAINT IF NOT EXISTS fk_decision_log_seat
    FOREIGN KEY (seat_id) REFERENCES seats(id) ON DELETE SET NULL;

-- Seat Challenges — performance trials between challenger and holder.
CREATE TABLE IF NOT EXISTS seat_challenges (
    id                    uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    seat_id               uuid NOT NULL REFERENCES seats(id) ON DELETE CASCADE,
    challenger_agent_id   uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    challenger_expert_id  uuid NOT NULL REFERENCES experts(id) ON DELETE CASCADE,
    holder_agent_id       uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    holder_expert_id      uuid NOT NULL REFERENCES experts(id) ON DELETE CASCADE,
    status                text NOT NULL DEFAULT 'pending'
                          CHECK (status IN (
                              'pending', 'approved', 'running',
                              'completed', 'rejected', 'cancelled'
                          )),
    trial_task_count      integer NOT NULL DEFAULT 10,
    trial_duration_days   integer NOT NULL DEFAULT 7,
    challenger_apl        float,
    holder_apl            float,
    result                text CHECK (result IN ('challenger_wins', 'holder_retains', NULL)),
    lockout_until         timestamptz,
    created_at            timestamptz NOT NULL DEFAULT now(),
    resolved_at           timestamptz
);

CREATE INDEX IF NOT EXISTS idx_challenges_seat   ON seat_challenges(seat_id);
CREATE INDEX IF NOT EXISTS idx_challenges_status ON seat_challenges(status);

-- Royalties — expert earnings per verified outcome.
-- Triggers via Stripe when APL close loop fires.
CREATE TABLE IF NOT EXISTS royalties (
    id                uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    expert_id         uuid NOT NULL REFERENCES experts(id) ON DELETE CASCADE,
    company_id        uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    agent_id          uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    seat_id           uuid REFERENCES seats(id) ON DELETE SET NULL,
    task_id           uuid REFERENCES tasks(id) ON DELETE SET NULL,
    amount_cents      bigint NOT NULL DEFAULT 0,
    currency          text NOT NULL DEFAULT 'USD',
    apl_at_time       float NOT NULL DEFAULT 0.0,
    settlement_method text NOT NULL DEFAULT 'stripe'
                      CHECK (settlement_method IN ('stripe', 'acp', 'onchain')),
    settlement_ref    text,
    status            text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'settled', 'failed')),
    created_at        timestamptz NOT NULL DEFAULT now(),
    settled_at        timestamptz
);

CREATE INDEX IF NOT EXISTS idx_royalties_expert  ON royalties(expert_id);
CREATE INDEX IF NOT EXISTS idx_royalties_company ON royalties(company_id);
CREATE INDEX IF NOT EXISTS idx_royalties_status  ON royalties(status);

-- Capability Registry — extensible plug-in catalog.
CREATE TABLE IF NOT EXISTS capability_registry (
    id                 uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    name               text NOT NULL UNIQUE,
    description        text NOT NULL DEFAULT '',
    category           text NOT NULL DEFAULT 'general'
                       CHECK (category IN (
                           'web', 'code', 'communication', 'data',
                           'artifact', 'trigger', 'settlement', 'general'
                       )),
    version            text NOT NULL DEFAULT '0.1.0',
    adapter_interface  text NOT NULL DEFAULT 'CapabilityAdapter',
    cost_tier          text NOT NULL DEFAULT 'standard'
                       CHECK (cost_tier IN ('free', 'low', 'standard', 'high', 'premium')),
    quality_tier       text NOT NULL DEFAULT 'standard'
                       CHECK (quality_tier IN ('basic', 'standard', 'high', 'premium')),
    is_builtin         boolean NOT NULL DEFAULT false,
    enabled            boolean NOT NULL DEFAULT true,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now()
);

-- Company-level overrides per capability
CREATE TABLE IF NOT EXISTS company_capability_overrides (
    id               uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id       uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    capability_id    uuid NOT NULL REFERENCES capability_registry(id) ON DELETE CASCADE,
    enabled          boolean NOT NULL DEFAULT true,
    config_overrides jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at       timestamptz NOT NULL DEFAULT now(),
    UNIQUE(company_id, capability_id)
);

CREATE INDEX IF NOT EXISTS idx_capability_category          ON capability_registry(category);
CREATE INDEX IF NOT EXISTS idx_capability_overrides_company ON company_capability_overrides(company_id);


-- ===========================================================================
-- SECTION 8: KNOWLEDGE GRAPH MEMORY
-- Replaces long system prompts with an Obsidian-style node graph.
-- Every node stores full provenance: task, session, timestamp, context.
-- Nodes exceeding 30,000 tokens are split into continuation chains.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS kg_nodes (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id              uuid NOT NULL,
    agent_id                uuid,

    -- Classification
    node_type               text NOT NULL
                            CHECK (node_type IN (
                                'fact', 'insight', 'procedure', 'decision', 'episode', 'blink'
                            )),
    scope                   text NOT NULL DEFAULT 'agent'
                            CHECK (scope IN ('agent', 'team', 'org')),

    -- Content
    title                   text NOT NULL,
    content                 text NOT NULL,
    token_count             integer NOT NULL DEFAULT 0,

    -- Provenance — required on every node
    -- These fields answer: where did this come from, when, and what was happening?
    emerged_from_task_id    uuid,
    emerged_from_session    text,
    emerged_at              timestamptz NOT NULL DEFAULT now(),
    emerged_context         jsonb,           -- { optimizationMode, confidenceScore, taskSpec }

    -- Continuation chain (splits nodes exceeding the 30k token cap)
    continues_node_id       uuid REFERENCES kg_nodes(id) ON DELETE SET NULL,
    is_continuation         boolean NOT NULL DEFAULT false,

    -- Retrieval
    embedding               vector(1536),
    tags                    text[] DEFAULT '{}',
    importance              float NOT NULL DEFAULT 0.5 CHECK (importance >= 0 AND importance <= 1),
    access_count            integer NOT NULL DEFAULT 0,
    last_accessed_at        timestamptz,

    -- Lifecycle
    valid_until             timestamptz,
    archived                boolean NOT NULL DEFAULT false,
    created_at              timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS kg_edges (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    from_node_id    uuid NOT NULL REFERENCES kg_nodes(id) ON DELETE CASCADE,
    to_node_id      uuid NOT NULL REFERENCES kg_nodes(id) ON DELETE CASCADE,
    relation        text NOT NULL
                    CHECK (relation IN (
                        'caused', 'supports', 'contradicts',
                        'continues', 'references', 'derived_from'
                    )),
    strength        float NOT NULL DEFAULT 0.5 CHECK (strength >= 0 AND strength <= 1),
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE(from_node_id, to_node_id, relation)
);

CREATE TABLE IF NOT EXISTS blink_cycles (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id      uuid NOT NULL,
    agent_id        uuid NOT NULL,
    task_id         uuid,
    trigger         text NOT NULL
                    CHECK (trigger IN (
                        'task_count', 'token_threshold',
                        'time_elapsed', 'cognitive_load', 'circuit_breaker'
                    )),
    what_matters    text NOT NULL,
    what_decided    text[] NOT NULL DEFAULT '{}',
    what_doing      text NOT NULL,
    commitments     text[] NOT NULL DEFAULT '{}',
    noise_released  text[] NOT NULL DEFAULT '{}',
    cognitive_load  text NOT NULL DEFAULT 'low'
                    CHECK (cognitive_load IN ('low', 'medium', 'high')),
    drift_risk      float NOT NULL DEFAULT 0.0 CHECK (drift_risk >= 0 AND drift_risk <= 1),
    tokens_before   integer NOT NULL DEFAULT 0,
    tokens_after    integer NOT NULL DEFAULT 0,
    nodes_archived  integer NOT NULL DEFAULT 0,
    created_at      timestamptz NOT NULL DEFAULT now()
);

-- HNSW index for fast cosine similarity search on KG nodes
-- Better than IVFFlat for low-latency retrieval; available in pgvector >= 0.5
CREATE INDEX IF NOT EXISTS idx_kg_nodes_embedding
    ON kg_nodes USING hnsw (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS idx_kg_nodes_company_type
    ON kg_nodes(company_id, node_type, archived) WHERE archived = false;

CREATE INDEX IF NOT EXISTS idx_kg_nodes_task
    ON kg_nodes(emerged_from_task_id) WHERE emerged_from_task_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_kg_nodes_continuation
    ON kg_nodes(continues_node_id) WHERE is_continuation = true;

CREATE INDEX IF NOT EXISTS idx_kg_edges_from ON kg_edges(from_node_id, relation);
CREATE INDEX IF NOT EXISTS idx_kg_edges_to   ON kg_edges(to_node_id, relation);
CREATE INDEX IF NOT EXISTS idx_blink_agent   ON blink_cycles(agent_id, company_id, created_at DESC);


-- ===========================================================================
-- SECTION 9: RUNTIME REINFORCEMENT LAYER
-- Thin contextual bandit overlay. Learns from live telemetry.
-- Never touches Core Memory, Policy Engine, or base models.
-- All updates are bounded, versioned, and fully auditable.
-- ===========================================================================

-- Adaptive Policy Store — per-task-type Q-values for routing,
-- escalation threshold delta, and budget multiplier.
-- One active row per (company_id, agent_id, task_type).
CREATE TABLE IF NOT EXISTS adaptive_policy_store (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id  uuid NOT NULL,
    agent_id    uuid NOT NULL,
    task_type   text NOT NULL
                CHECK (task_type IN ('fast', 'standard', 'judgment_heavy', 'sensitive')),
    version     integer NOT NULL DEFAULT 1,
    params      jsonb NOT NULL DEFAULT '{
        "routerWeights": {},
        "escalationThresholdDelta": 0.0,
        "budgetMultiplier": 1.0,
        "retryWeighting": 1.0,
        "delegationDepthFactor": 1.0,
        "alpha": 0.05,
        "updateCount": 0,
        "frozen": false
    }'::jsonb,
    is_active   boolean NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- Only one active row per (company, agent, task_type)
CREATE UNIQUE INDEX IF NOT EXISTS adap_policy_active_idx
    ON adaptive_policy_store(company_id, agent_id, task_type)
    WHERE is_active = true;

-- Adaptive Audit Log — immutable record of every parameter update.
-- DB rules block UPDATE and DELETE.
CREATE TABLE IF NOT EXISTS adaptive_audit_log (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id      uuid NOT NULL,
    agent_id        uuid NOT NULL,
    task_id         uuid,
    task_type       text,
    reward_vector   jsonb NOT NULL,   -- {outcomeDelta, costEfficiency, escalationPrecision, overridePenalty, calibrationError, total}
    params_before   jsonb NOT NULL,
    params_after    jsonb NOT NULL,
    alpha_used      float NOT NULL,
    frozen          boolean NOT NULL DEFAULT false,
    freeze_reason   text,
    created_at      timestamptz NOT NULL DEFAULT now()
);

-- Immutable: block UPDATE and DELETE
CREATE RULE no_update_adaptive_audit AS ON UPDATE TO adaptive_audit_log DO INSTEAD NOTHING;
CREATE RULE no_delete_adaptive_audit AS ON DELETE TO adaptive_audit_log DO INSTEAD NOTHING;

CREATE INDEX IF NOT EXISTS adap_audit_company ON adaptive_audit_log(company_id, agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS adap_audit_task    ON adaptive_audit_log(task_id) WHERE task_id IS NOT NULL;


-- ===========================================================================
-- SETUP COMPLETE
--
-- What to do next:
--
-- 1. CONFIGURE CREDENTIALS TABLE
--    Create a 'key_proxy' Postgres role and give it exclusive SELECT on credentials:
--      CREATE ROLE key_proxy NOLOGIN;
--      GRANT SELECT ON credentials TO key_proxy;
--    All other roles must NOT have SELECT on credentials.
--
-- 2. POPULATE EXTENSIONS FOR VECTOR SEARCH
--    After inserting your first embeddings, rebuild the vector index for better perf:
--      REINDEX INDEX idx_semantic_memory_embedding;
--      REINDEX INDEX idx_kg_nodes_embedding;
--
-- 3. SET SUPABASE RLS (if using Supabase)
--    Row-Level Security is enabled on `credentials` by default.
--    For all other tables, add RLS policies scoped to company_id
--    using the Supabase service role or your JWT claims.
--    Recommended pattern:
--      ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
--      CREATE POLICY tasks_company_isolation ON tasks
--        USING (company_id = (current_setting('app.company_id'))::uuid);
--
-- 4. ON BARE POSTGRES (no Supabase)
--    a. Install pgvector: https://github.com/pgvector/pgvector
--    b. Create the database:
--         createdb onlyreason
--         psql -d onlyreason -c "CREATE EXTENSION vector;"
--    c. Run this file:
--         psql -d onlyreason -f backend_setup.sql
--    d. Create application roles:
--         CREATE ROLE runtime_agent LOGIN PASSWORD '...';
--         GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO runtime_agent;
--         REVOKE SELECT ON credentials FROM runtime_agent;
--         CREATE ROLE key_proxy LOGIN PASSWORD '...';
--         GRANT SELECT ON credentials TO key_proxy;
--
-- 5. ENVIRONMENT VARIABLES
--    Set these in your .env before starting the runtime:
--      SUPABASE_URL or DATABASE_URL
--      SUPABASE_ANON_KEY or PGPASSWORD
--      REDIS_URL            (BullMQ task queue)
--      CREDENTIAL_ENCRYPTION_KEY  (AES-256, 32 bytes, base64)
--      SERVICE_TOKEN        (shared auth between runtime and judgment service)
--      AGENT_ID             (UUID of this agent)
--      COMPANY_ID           (UUID of the company)
--      ANTHROPIC_API_KEY
--      OPENAI_API_KEY
--
-- ===========================================================================
