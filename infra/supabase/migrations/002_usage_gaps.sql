-- ============================================================
-- Only Reason 0 Agent — Migration 002: Usage Gaps
--
-- Adds tables and alterations identified from Usage.md:
-- decision_log, active_context, apl_baselines, seats,
-- seat_challenges, royalties, capability_registry
-- ============================================================

-- ============================================================
-- DECISION LOG (append-only, like telemetry_events)
-- Records every significant decision by any agent or human.
-- ============================================================
CREATE TABLE decision_log (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id          UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    agent_id            UUID REFERENCES agents(id) ON DELETE SET NULL,
    seat_id             UUID,  -- FK added after seats table creation
    decision_title      TEXT NOT NULL,
    description         TEXT NOT NULL DEFAULT '',
    rationale           TEXT NOT NULL DEFAULT '',
    made_by             UUID NOT NULL,
    made_by_type        TEXT NOT NULL CHECK (made_by_type IN ('agent', 'human')),
    outcome             TEXT,
    outcome_recorded_at TIMESTAMPTZ,
    tags                TEXT[] DEFAULT '{}',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_decision_log_company ON decision_log(company_id);
CREATE INDEX idx_decision_log_agent ON decision_log(agent_id);
CREATE INDEX idx_decision_log_made_by ON decision_log(made_by);

-- Append-only enforcement (same pattern as telemetry_events)
CREATE OR REPLACE FUNCTION prevent_decision_log_modification()
RETURNS TRIGGER AS $$
BEGIN
    -- Allow UPDATE only on outcome and outcome_recorded_at (recording results)
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'decision_log is append-only. DELETE is not allowed.';
    END IF;
    IF TG_OP = 'UPDATE' THEN
        -- Only allow outcome fields to be updated
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

CREATE TRIGGER trg_decision_log_protect
    BEFORE UPDATE OR DELETE ON decision_log
    FOR EACH ROW EXECUTE FUNCTION prevent_decision_log_modification();

-- ============================================================
-- ACTIVE CONTEXT (company-scoped, persistent)
-- Hydrated on every agent boot. Updated after every task.
-- ============================================================
CREATE TABLE active_context (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id          UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    priorities          JSONB NOT NULL DEFAULT '[]'::jsonb,
    in_flight_tasks     JSONB NOT NULL DEFAULT '[]'::jsonb,
    open_questions      JSONB NOT NULL DEFAULT '[]'::jsonb,
    active_experiments  JSONB NOT NULL DEFAULT '[]'::jsonb,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by_agent    UUID REFERENCES agents(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX idx_active_context_company ON active_context(company_id);

-- ============================================================
-- APL BASELINES (pre-agent KPI snapshots)
-- Belongs to the company. Set before agent deployment.
-- ============================================================
CREATE TABLE apl_baselines (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    kpi_name        TEXT NOT NULL,
    baseline_value  FLOAT NOT NULL,
    measured_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    measured_by     UUID,  -- human who set the baseline
    notes           TEXT DEFAULT ''
);

CREATE INDEX idx_apl_baselines_company ON apl_baselines(company_id);
CREATE INDEX idx_apl_baselines_kpi ON apl_baselines(kpi_name);
CREATE UNIQUE INDEX idx_apl_baselines_company_kpi ON apl_baselines(company_id, kpi_name);

-- ============================================================
-- SEATS (contestable roles within a company)
-- A seat is a function (PM, Dev, etc.) that an agent holds.
-- ============================================================
CREATE TABLE seats (
    id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id              UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    role                    TEXT NOT NULL,  -- 'PM', 'Dev', 'Growth', 'Sales', etc.
    scope                   TEXT NOT NULL DEFAULT '',
    current_agent_id        UUID REFERENCES agents(id) ON DELETE SET NULL,
    current_expert_id       UUID REFERENCES experts(id) ON DELETE SET NULL,
    apl_score               FLOAT NOT NULL DEFAULT 0.0,
    performance_window_days INTEGER NOT NULL DEFAULT 21,
    challenge_threshold     FLOAT NOT NULL DEFAULT 0.1,
    challenge_eligible_after TIMESTAMPTZ,
    status                  TEXT NOT NULL DEFAULT 'open'
                            CHECK (status IN ('open', 'held', 'challenge_in_progress', 'frozen')),
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_seats_company ON seats(company_id);
CREATE INDEX idx_seats_agent ON seats(current_agent_id);
CREATE INDEX idx_seats_expert ON seats(current_expert_id);
CREATE INDEX idx_seats_role ON seats(role);

-- Now add FK from decision_log to seats
ALTER TABLE decision_log
    ADD CONSTRAINT fk_decision_log_seat
    FOREIGN KEY (seat_id) REFERENCES seats(id) ON DELETE SET NULL;

-- ============================================================
-- SEAT CHALLENGES (performance trials)
-- ============================================================
CREATE TABLE seat_challenges (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    seat_id             UUID NOT NULL REFERENCES seats(id) ON DELETE CASCADE,
    challenger_agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    challenger_expert_id UUID NOT NULL REFERENCES experts(id) ON DELETE CASCADE,
    holder_agent_id     UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    holder_expert_id    UUID NOT NULL REFERENCES experts(id) ON DELETE CASCADE,
    status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN (
                            'pending', 'approved', 'running',
                            'completed', 'rejected', 'cancelled'
                        )),
    trial_task_count    INTEGER NOT NULL DEFAULT 10,
    trial_duration_days INTEGER NOT NULL DEFAULT 7,
    challenger_apl      FLOAT,
    holder_apl          FLOAT,
    result              TEXT CHECK (result IN ('challenger_wins', 'holder_retains', NULL)),
    lockout_until       TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at         TIMESTAMPTZ
);

CREATE INDEX idx_challenges_seat ON seat_challenges(seat_id);
CREATE INDEX idx_challenges_status ON seat_challenges(status);

-- ============================================================
-- ROYALTIES (expert earnings per task)
-- ============================================================
CREATE TABLE royalties (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    expert_id           UUID NOT NULL REFERENCES experts(id) ON DELETE CASCADE,
    company_id          UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    agent_id            UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    seat_id             UUID REFERENCES seats(id) ON DELETE SET NULL,
    task_id             UUID REFERENCES tasks(id) ON DELETE SET NULL,
    amount_cents        BIGINT NOT NULL DEFAULT 0,
    currency            TEXT NOT NULL DEFAULT 'USD',
    apl_at_time         FLOAT NOT NULL DEFAULT 0.0,
    settlement_method   TEXT NOT NULL DEFAULT 'stripe'
                        CHECK (settlement_method IN ('stripe', 'acp', 'onchain')),
    settlement_ref      TEXT,
    status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'settled', 'failed')),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    settled_at          TIMESTAMPTZ
);

CREATE INDEX idx_royalties_expert ON royalties(expert_id);
CREATE INDEX idx_royalties_company ON royalties(company_id);
CREATE INDEX idx_royalties_status ON royalties(status);

-- ============================================================
-- CAPABILITY REGISTRY (extensible adapter catalog)
-- Any developer can register a capability. Companies can
-- enable/disable per-agent. Supports future plug-in additions.
-- ============================================================
CREATE TABLE capability_registry (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name                TEXT NOT NULL UNIQUE,
    description         TEXT NOT NULL DEFAULT '',
    category            TEXT NOT NULL DEFAULT 'general'
                        CHECK (category IN (
                            'web', 'code', 'communication', 'data',
                            'artifact', 'trigger', 'settlement', 'general'
                        )),
    version             TEXT NOT NULL DEFAULT '0.1.0',
    adapter_interface   TEXT NOT NULL DEFAULT 'CapabilityAdapter',
    cost_tier           TEXT NOT NULL DEFAULT 'standard'
                        CHECK (cost_tier IN ('free', 'low', 'standard', 'high', 'premium')),
    quality_tier        TEXT NOT NULL DEFAULT 'standard'
                        CHECK (quality_tier IN ('basic', 'standard', 'high', 'premium')),
    is_builtin          BOOLEAN NOT NULL DEFAULT FALSE,
    enabled             BOOLEAN NOT NULL DEFAULT TRUE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_capability_category ON capability_registry(category);
CREATE INDEX idx_capability_cost ON capability_registry(cost_tier);

-- Company-specific capability overrides
CREATE TABLE company_capability_overrides (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    capability_id   UUID NOT NULL REFERENCES capability_registry(id) ON DELETE CASCADE,
    enabled         BOOLEAN NOT NULL DEFAULT TRUE,
    config_overrides JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(company_id, capability_id)
);

CREATE INDEX idx_capability_overrides_company ON company_capability_overrides(company_id);

-- ============================================================
-- SCHEMA ALTERATIONS — extend existing tables
-- ============================================================

-- org_knowledge_graph: expand entity types
ALTER TABLE org_knowledge_graph
    DROP CONSTRAINT IF EXISTS org_knowledge_graph_entity_type_check;
ALTER TABLE org_knowledge_graph
    ADD CONSTRAINT org_knowledge_graph_entity_type_check
    CHECK (entity_type IN (
        'person', 'project', 'decision', 'relationship',
        'product', 'customer', 'experiment', 'process'
    ));

-- approval_queue: add correction feedback fields
ALTER TABLE approval_queue
    ADD COLUMN IF NOT EXISTS correction_content TEXT DEFAULT '',
    ADD COLUMN IF NOT EXISTS correction_incorporated BOOLEAN DEFAULT FALSE;

-- experts: add bio and category for marketplace
ALTER TABLE experts
    ADD COLUMN IF NOT EXISTS bio TEXT DEFAULT '',
    ADD COLUMN IF NOT EXISTS category TEXT DEFAULT '';

-- companies: add optimization mode
ALTER TABLE companies
    ADD COLUMN IF NOT EXISTS optimization_mode TEXT NOT NULL DEFAULT 'balanced'
        CHECK (optimization_mode IN ('quality', 'cost', 'balanced', 'speed')),
    ADD COLUMN IF NOT EXISTS optimization_config JSONB NOT NULL DEFAULT '{}'::jsonb;
