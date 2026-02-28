# Only Reason — The 0 Agent

> **A judgment-native AI agent runtime.**
> Built to carry expert human thinking, stay coherent over long deployments, and get measurably better over time.

---

## Why This Is Different From Every Other Agent You've Used

Before you read the architecture, you need to understand what problem this is actually solving — because it's not the same problem LangChain, AutoGen, CrewAI, or any other framework is solving.

### What existing agent frameworks do

LangChain, LangGraph, AutoGen, and CrewAI are **capability frameworks**. They give you tools to connect LLMs to APIs, chain prompts together, run loops, and manage state. They're well-built for what they are.

The mental model: *"Here is a capable model. Here are some tools. Connect them and define what you want it to do."*

If you want it to behave like a specific expert, you write a system prompt. The system prompt describes the expert. It is not the expert.

### What the 0 Agent does differently

The 0 Agent is not a capability framework. It is a **judgment runtime**.

The most valuable thing an AI agent can carry is not a tool call or a prompt. It is a specific person's way of thinking — their pattern recognition, their instincts, their sense of when something is wrong before they can explain why. That kind of judgment does not come from writing a better system prompt. It comes from watching an expert work and learning to see through their eyes.

Once an expert's judgment is encoded, every task the agent handles — regardless of which LLM is running underneath — is filtered through that expert's perspective before a result is returned. Not as a wrapper. As a trained cognitive lens.

### The concrete difference

| | LangChain / AutoGen / CrewAI | Only Reason 0 Agent |
|---|---|---|
| **What it learns from** | System prompt you write | Expert working naturally |
| **What it carries** | Instructions | Judgment |
| **Basis for decisions** | General training + your prompt | Specific expert's pattern recognition |
| **Novel situations** | Falls back to general training | Applies trained expert instinct |
| **Knowing when to stop** | You define rules | Expert's escalation triggers, learned from observation |
| **Memory** | Session-scoped or manually managed | Knowledge graph with provenance on every node |
| **Self-improvement** | None (static) | Runtime RL layer adapts routing and thresholds from live outcomes |
| **Model flexibility** | Usually provider-specific | Routes across any provider per task type |

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Chapter 1 — Training](#chapter-1--training)
3. [Chapter 2 — Wake Up](#chapter-2--wake-up)
4. [Chapter 3 — Thinking](#chapter-3--thinking)
5. [Chapter 4 — The LLM Router](#chapter-4--the-llm-router)
6. [Chapter 5 — Execution](#chapter-5--execution)
7. [Chapter 6 — Coordination](#chapter-6--coordination)
8. [Chapter 7 — Measurement](#chapter-7--measurement)
9. [Memory Architecture](#memory-architecture)
10. [Runtime Reinforcement Layer](#runtime-reinforcement-layer)
11. [Security Model](#security-model)
12. [Global CLI — 0agent](#global-cli-0agent)
13. [Quick Start](#quick-start)
14. [Skill System](#skill-system)
15. [Repository Structure](#repository-structure)
16. [The Loop That Closes](#the-loop-that-closes)

---

## ⚡ Quick Start

The fastest way to get your first agent live is using the onboarding wizard.

1.  **Clone & Install**
    ```bash
    git clone https://github.com/onlyreason/0agent
    cd 0agent
    ```

2.  **Start the Wizard**
    ```bash
    ./start.sh
    ```
    The wizard will check your prerequisites (Node 20+, Docker), install dependencies, and guide you through choosing an LLM provider and setting up your Telegram bot.

---

## 🛢️ Database Setup (Persistent Memory)

By default, the agent runs with **ephemeral memory** (lost on restart) if you leave the Supabase URL blank during setup. To enable persistent memory:

### 1. Initialize Supabase
1. Create a project at [supabase.com](https://supabase.com).
2. Open the **SQL Editor**.
3. Paste and run the contents of [backend_setup.sql](./backend_setup.sql). This creates the necessary tables, indices, and triggers for the 0agent judgment runtime.

### 2. Connect Your Agent
Run `./start.sh` again and provide:
- **Supabase URL**: `https://your-project.supabase.co`
- **Service Role Key**: Your secret key from `Settings -> API`.



## Architecture Overview

The 0 Agent is structured as a **seven-chapter execution flow**, not a layered diagram. Every task moves through these chapters in order:

```
EXPERT ──trains──► [① Training] ──encodes into──► Core Memory
                                                        │
FOUNDER ──gives goal──► [② Wake Up] ◄──always loaded──┘
                              │
                         [③ Thinking]
                         DAG · Budget · Policy · Circuit Breaker · InterruptStore
                              │
                         [Skills Loader]
                         Context-aware dynamic skill injection
                              │
                    ┌─────────┴─────────┐
                    │                   │
              needs approval?      proceed
                    │                   │
               [Pause]            [④ LLM Router]
                    │              Classify → Select → Expert Lens
               [Approved] ─────────────►│
                                   [⑤ Execution]
                                        │
                                   [⑥ Coordination]
                                        │
                                   [⑦ Measurement]
                                   APL · RL Update · KG Write
```

**Memory** and **Security** run continuously underneath all seven chapters. **The RL layer** fires after every task completes.

---

## Chapter 1 — Training

*How the expert's judgment gets encoded.*

An expert works alongside the AI through normal conversation — not a form, not a config screen. The training service captures their thinking through voice calls, screen shares, Slack reactions, and live correction loops.

What gets encoded:

- **Domain pattern recognition** — what the expert notices first in a situation
- **Escalation triggers** — the specific signals that say "get a human"
- **Confidence calibration** — where to act fast, where to slow down, where to always ask
- **Hard constraints** — things they would never do regardless of instruction
- **Contextual judgment** — how their approach shifts by situation type

All of this is written into **Core Memory** — a locked store that the runtime can only read. It never changes unless the expert explicitly retrains.

---

## Chapter 2 — Wake Up

*What the agent loads before doing anything.*

Every task arrival triggers assembly of a **TaskEnvelope** — the object that travels through every subsequent chapter.

```
TaskEnvelope
├── expertJudgment    Hard constraints · escalation triggers · confidence map
├── orgContext        KG nodes retrieved for this task · BlinkState · decisions
├── task              Spec · priority · deadline · budget
├── securityContext   Agent identity · company · permissions
└── complianceLog     Immutable audit trail
```

**No long system prompts.** The org context is assembled from the Knowledge Graph — semantically relevant nodes retrieved per task, not a full dump. The agent receives a BlinkState (compact focus block) and up to 8 relevant nodes, typically under 8k tokens total.

---

## Chapter 3 — Thinking

*Planning, cost estimation, policy checking, and failure prevention.*

### Task graph construction

Complex goals decompose into a **DAG** — a dependency tree where some branches run in parallel and others wait. When an upstream task fails, the cascade breaker automatically fails all downstream dependents rather than letting them stall.

### Budget estimation

Cost is estimated before execution begins. The BudgetEngine enforces three limits:
- Per-task cost ceiling
- Session total ceiling
- Per-hour rate limit

### Policy check

Every task runs through the **Policy Engine** — hard rules from both the expert (set during training) and the operator (set during deployment). No instruction can override them.

### Circuit Breaker

Before reaching the LLM, six failure modes are checked:

| Breaker | What it catches |
|---------|----------------|
| IterationBreaker | Reasoning loops — too many calls per task, no-progress streaks |
| DuplicateDetector | Near-duplicate outputs via Jaccard similarity |
| ProviderHealthTracker | Closed→Open→Half-Open per provider, based on error rate and latency |
| BudgetEngine | Session ceiling and hourly rate limit |
| ApprovalGate | Configurable timeout — auto-reject or auto-approve-low-risk on expiry |
| DAG Cascade | Auto-fails downstream nodes when an upstream dependency dies |

### Approval gate

High-stakes tasks pause and surface for human review. State is fully preserved. When approved, execution resumes from the exact point it paused. Nothing re-runs. No side effects are duplicated.

---

## Chapter 4 — The LLM Router

*Picking the right model for this specific task.*

No task is hardcoded to any provider. The router classifies each task and selects accordingly:

| Task type | What it means | Typical model |
|---|---|---|
| `judgment_heavy` | Nuanced reasoning, pattern matching | Claude Opus, GPT-4o |
| `standard` | Writing, analysis, summarisation | Claude Sonnet, GPT-4o mini |
| `fast` | Routing, tagging, simple extraction | Local or cheap model |
| `sensitive` | Data that should not leave the org | Local self-hosted model |

**The expert lens filter:** every output from every model passes through a structured comparison against Core Memory before reaching execution. Constraint violation → blocked. Low confidence → escalate flag set.

**The RL adapter:** the `RouterPolicyAdapter` wraps `selectProvider()` with Q-values learned from live outcomes. If a provider reliably produces better APL for judgment-heavy tasks at this company, its weight increases. Falls back to base routing when frozen.

---

## Chapter 5 — Execution

*Real actions in the real world.*

Every tool goes through a **CapabilityAdapter** interface. No direct third-party calls from agent code. The adapter declares what it can do, handles auth through the Key Proxy, normalises results, and reports failure modes.

Adding a new capability:
1. Implement `CapabilityAdapter`
2. Register it with the capability registry
3. The agent discovers it on next boot — nothing else in the system changes

**Built-in:** Execution Sandbox · Coding Agent (git-native, test-aware)

**Pluggable:** Browser (Playwright, Puppeteer) · Email · Slack · Calendar · REST APIs · GraphQL · CRM · Files · Scheduling · Payments

---

## Chapter 6 — Coordination

*Working with other agents and humans.*

Agents coordinate via **typed task contracts**, not natural language:

```
TaskContract {
    inputSchema         // exactly what's being passed, with types
    outputSchema        // exactly what's expected back, with types
    acceptanceCriteria  // machine-readable completion conditions
    outcomePointer      // business KPI this task contributes to
}
```

**Trust is scored by APL, not assumed.** A newly provisioned agent starts with low trust. An agent with a long record of verified positive outcomes earns deeper collaboration. This is fundamentally different from frameworks where agents share an API key and trust each other by default.

---

## Chapter 7 — Measurement

*Did the expert's judgment actually help?*

### APL — Agent Performance Lift

APL answers: *did the agent's involvement produce a measurably better outcome than what would have happened without it?*

1. Define a KPI relevant to the task
2. Establish a baseline before deployment
3. After an outcome window closes, measure the same metric
4. Compute the delta; check statistical significance

APL is not self-reported. It is derived from real business outcomes, measured after the fact, tied to specific decisions and agents.

### Royalty trigger

When an APL measurement closes and a business outcome is verified, the system fires an automatic Stripe payment to the expert whose judgment powered the result. Their notification names exactly what happened — what the agent did, what it produced, what they earned.

This is the loop closing.

---

## Memory Architecture

Five distinct memory tiers, each with different scope and function.

### Core Memory
The expert's encoded identity. Read-only for the runtime. Written only by the training service. Never changes during task execution.

### Working Memory
Task-scoped, ephemeral. Lives in Redis during execution; Postgres as the durable fallback.

### Episodic Memory
Persistent log of past sessions. The agent gets better at its job over time by retrieving relevant episodes when it encounters familiar situations.

### Semantic Memory
pgvector embeddings for meaning-based retrieval. Searchable by what something means, not exact wording.

### Knowledge Graph Memory
The main context layer. An Obsidian-style directed node graph where:

- Every node has full **provenance**: `emerged_from_task_id`, `emerged_at`, `emerged_context`
- Nodes write their own continuation chain when content exceeds **30,000 tokens**
- **Blink cycles** periodically compress working context — triggered by token threshold (24k), task count (every 5), elapsed time (30 min), or cognitive load indicators
- Agents receive a compact `BlinkState` answering three questions: *what actually matters right now, what have we decided, what are we doing*

Edges are typed: `caused · supports · contradicts · continues · references · derived_from`

---

## Runtime Reinforcement Layer

A contextual bandit overlay that learns from live telemetry. Does not retrain base models. Does not modify expert judgment. Does not touch Core Memory.

**Q-update rule:**
```
Q_new = Q_old + alpha * (reward - Q_old)
alpha = 0.05 base, halved after 5 consecutive APL drops
```

**5-component reward vector:**

| Component | Weight | What it measures |
|-----------|--------|-----------------|
| `outcomeDelta` | 0.40 | APL change vs baseline |
| `costEfficiency` | 0.20 | Budget utilisation |
| `escalationPrecision` | 0.20 | Was the escalation warranted? |
| `overridePenalty` | 0.10 | Did a human have to override? |
| `calibrationError` | 0.10 | Confidence score vs actual outcome |

**Parameters adapted over time:**
- Model routing weights per task type (`routerWeights`)
- Escalation confidence threshold shift (`escalationThresholdDelta`, bounded ±0.20)
- Budget multiplier per task class (`budgetMultiplier`, bounded 0.5×–2.0×)

**Safety guardrails:**
1. Reward variance > 0.6 over last 10 updates → freeze all adaptation
2. APL drops ≥ 5 consecutive tasks → halve alpha
3. Per-update delta capped at 10% of parameter range
4. Every update written to an immutable audit log (DB-enforced)

---

## Security Model

Security runs underneath everything. It is not a feature.

**Key Proxy** — The agent never holds credentials. All third-party calls go through a proxy that injects the right key at call time. Credentials are AES-256 encrypted at rest. If an agent is compromised, it cannot leak credentials. All telemetry payloads are scanned for credential leaks before logging.

**Scoped Permissions** — Each agent has a capability manifest: a declaration of exactly what tools and data it may access. It cannot reach beyond what it was explicitly granted, regardless of what any instruction says.

**Policy Engine** — Hard rules set by the expert during training and the operator during deployment. No instruction from any source overrides these.

**Immutable Audit Log** — Every action, model call, and tool invocation is written to an append-only event stream. It cannot be modified after the fact.

**RLS on Credentials** — The credentials table has Row-Level Security enabled. Only the `key_proxy` database role may SELECT from it.

---

---

## Global CLI — 0agent

The 0 Agent is primarily interacted with via the global `0agent` command. This ensures a consistent, interactive terminal experience regardless of the underlying environment.

| Command | Action |
|---------|--------|
| `0agent onboard` | Interactive setup: Docker check, API keys, UUID generation |
| `0agent start` | Boots the agent infrastructure in the background |
| `0agent task "<spec>"` | Submits a task with real-time streaming output |
| `0agent stop` | Halts a specific task or shuts down the entire agent |
| `0agent status` | Shows active tasks, uptime, and daily usage |
| `0agent skills` | Manage the agent's repository of SKILL.md files |
| `0agent logs --tail` | Real-time log streaming from the runtime |

---

## Quick Start

### 1. Install & Onboard

```bash
npm install -g 0agent
0agent onboard
```
The onboard wizard will guide you through Docker verification, LLM provider setup, and generating your secure `AGENT_ID` and `SERVICE_TOKEN`.

### 2. Start the Infrastructure

```bash
0agent start -d
```
This launches the Postgres, Redis, Runtime, Judgment, and Sandbox services via Docker.

### 3. Run Your First Task

```bash
0agent task "Summarize the latest trends in agentic AI memory architecture"
```

---

## Skill System

The 0 Agent uses a filesystem-native skill system compatible with **agent-zero** and **SKILL.md** standards.

- **Location**: `workspace/skills/`
- **Dynamic Injection**: The `SkillLoader` matches task specs against available skills (via semantic similarity) and injects only relevant skill blocks into the prompt.
- **Portability**: You can drop any `SKILL.md` into the `installed/` directory, or use `0agent skills install <url>`.

---

---

## Repository Structure

```
only-reason/
├── backend_setup.sql             Single-file DB setup (run this first)
│
├── packages/
│   ├── runtime/                  TypeScript agent runtime
│   │   └── src/
│   │       ├── core/
│   │       │   ├── envelope.ts           TaskEnvelope + all core types
│   │       │   ├── orchestrator.ts       7-chapter execution loop + DAG
│   │       │   ├── policy-engine.ts      5-layer prompt injection defense
│   │       │   ├── budget-engine.ts      Token limits + session ceiling
│   │       │   ├── approval-gate.ts      Human-in-the-loop with timeout
│   │       │   └── circuit-breaker.ts    Loop/dup/provider health breakers
│   │       ├── router/
│   │       │   └── llm-router.ts         Classify → Select → Expert Lens
│   │       ├── memory/
│   │       │   ├── kg-store.ts           Knowledge graph (30k cap, continuation chains)
│   │       │   ├── blink.ts              Blink cycle engine
│   │       │   └── memory-manager.ts     KG-native context assembly
│   │       ├── reinforcement/
│   │       │   ├── reinforcement-engine.ts   Q-update + safety guardrails
│   │       │   ├── reward-calculator.ts      5-component reward vector
│   │       │   ├── adaptive-policy-store.ts  Versioned param store
│   │       │   ├── router-policy-adapter.ts  Router overlay
│   │       │   ├── escalation-threshold-adapter.ts
│   │       │   └── measurement-hook.ts   Post-task RL trigger
│   │       ├── adapters/
│   │       │   └── key-proxy.ts          Credential encryption + injection
│   │       └── telemetry/
│   │           ├── logger.ts             Append-only event stream
│   │           └── apl-engine.ts         Business outcome measurement
│   │
│   └── judgment/                 Python expert training service
│       └── src/
│           ├── api/              FastAPI — training + retrieval routes
│           ├── memory/           Core memory R/W + semantic memory
│           ├── training/         Session handler, voice, NLP extractor
│           └── retrieval/        Envelope builder + scoring
│
└── infra/
    ├── docker-compose.yml
    ├── nginx/
    └── supabase/migrations/      Individual migration files (reference only)
```

---

## The Loop That Closes

Every architectural decision exists in service of one thing.

```
Expert trains    → judgment encoded from natural co-working
Agent deploys    → expert's thinking carried into companies that need it
Founder uses it  → real decisions, real problems, real stakes
Outcomes measured → APL computed against baseline, weeks after the fact
Expert paid      → Stripe royalty fires; notification names exactly what happened
Agent adapts     → RL layer updates routing weights and thresholds from outcomes
Expert told      → the loop becomes visible, not just closed
```

When an expert receives a notification that says *"your agent reviewed fourteen pitch decks this week, flagged three for follow-up, and earned you $340"* — the thesis is proved. Not theoretically. Empirically.

Everything in this architecture exists to make that moment possible, repeatable, and scalable.

---

## Contributing

The coordination protocol, memory architecture, and capability adapter interface are designed as open primitives. To add a capability adapter, extend the memory system, or implement an alternative coordination transport, start with the interfaces in `packages/runtime/src/`.

All PRs must pass `tsc --noEmit` with 0 errors.

---

## License

TBD — coordination primitives will be open source. Marketplace, measurement, and royalty infrastructure are proprietary.

---

*Only Reason — The operating system for companies that run on AI agents.*
*Capability must scale with constraint. We are building the constraint layer.*
