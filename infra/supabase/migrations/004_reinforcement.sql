-- 004_reinforcement.sql
-- Runtime Reinforcement Layer — adaptive execution parameters.
-- A thin overlay that reads telemetry and adjusts routing/escalation/budget
-- without touching Core Memory, Policy Engine, or expert constraints.

-- ============================================================
-- Adaptive Policy Store
-- Org-scoped, versioned adaptive parameters per task type.
-- Only one active row per (company_id, agent_id, task_type).
-- ============================================================

CREATE TABLE IF NOT EXISTS adaptive_policy_store (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id      uuid NOT NULL,
    agent_id        uuid NOT NULL,
    task_type       text NOT NULL,  -- fast | standard | judgment_heavy | sensitive
    version         int NOT NULL DEFAULT 1,

    -- Adaptive parameters (all have bounded ranges)
    params          jsonb NOT NULL DEFAULT '{
        "routerWeights": {},
        "escalationThresholdDelta": 0.0,
        "budgetMultiplier": 1.0,
        "retryWeighting": 1.0,
        "delegationDepthFactor": 1.0,
        "alpha": 0.05,
        "updateCount": 0,
        "frozen": false
    }'::jsonb,

    is_active       boolean NOT NULL DEFAULT true,
    created_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT adp_task_type_check
        CHECK (task_type IN ('fast', 'standard', 'judgment_heavy', 'sensitive'))
);

-- Only one active row per scope
CREATE UNIQUE INDEX IF NOT EXISTS adap_policy_active_idx
    ON adaptive_policy_store(company_id, agent_id, task_type)
    WHERE is_active = true;

CREATE INDEX IF NOT EXISTS adap_policy_company
    ON adaptive_policy_store(company_id, agent_id, is_active);

-- ============================================================
-- Adaptive Audit Log
-- Immutable record of every parameter update.
-- DB rules prevent UPDATE and DELETE.
-- ============================================================

CREATE TABLE IF NOT EXISTS adaptive_audit_log (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id      uuid NOT NULL,
    agent_id        uuid NOT NULL,
    task_id         uuid,
    task_type       text,

    -- Full reward breakdown
    reward_vector   jsonb NOT NULL,     -- {outcomeDelta, costEfficiency, escalationPrecision, overridePenalty, calibrationError, total}

    -- Parameter diff
    params_before   jsonb NOT NULL,
    params_after    jsonb NOT NULL,

    -- Learning metadata
    alpha_used      float NOT NULL,
    frozen          boolean NOT NULL DEFAULT false,
    freeze_reason   text,              -- why frozen, if applicable

    created_at      timestamptz NOT NULL DEFAULT now()
);

-- Immutable: block UPDATE and DELETE
CREATE RULE no_update_adaptive_audit AS ON UPDATE TO adaptive_audit_log DO INSTEAD NOTHING;
CREATE RULE no_delete_adaptive_audit AS ON DELETE TO adaptive_audit_log DO INSTEAD NOTHING;

CREATE INDEX IF NOT EXISTS adap_audit_company
    ON adaptive_audit_log(company_id, agent_id, created_at DESC);

CREATE INDEX IF NOT EXISTS adap_audit_task
    ON adaptive_audit_log(task_id)
    WHERE task_id IS NOT NULL;
