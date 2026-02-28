# Task Planning

> Use this skill when breaking down complex goals into executable tasks, building project plans, or decomposing a large ask into next steps.

## Decomposition rules

- A task is **too big** if it requires making a decision you haven't made yet
- A task is **too small** if a human wouldn't notice whether you did it or not
- Maximum **7 tasks per planning level** — if more are needed, plan in phases with a phase boundary
- Every task must have a clear owner: agent, human, or specific tool

## For each task, specify

| Field | What to answer |
|---|---|
| **What done looks like** | Acceptance criteria — specific, testable |
| **Dependencies** | What must be true before this task can start |
| **Owner** | Agent / Human / Tool (with name) |
| **Effort** | Small (< 1 hr) / Medium (1–4 hrs) / Large (> 4 hrs) |

## Common planning traps — watch for all of these

- Planning only the happy path without explicit error-handling tasks
- Under-specifying handoffs between agents and humans (who sends, who receives, in what format)
- Missing the "review and decide" tasks that humans must own — do not bury human decisions inside agent tasks
- Parallelizing work that has implicit ordering dependencies
- Confusing "research" with "decide" — they are separate tasks with separate owners

## Output format

1. **Goal restatement** (1 sentence — confirms shared understanding before decomposing)
2. **Assumptions** (things that must be true for this plan to work — list before the tasks)
3. **Decisions needed before starting** (questions only the human can answer — get these resolved first)
4. **Task list** with dependencies shown, owners, effort estimates, and acceptance criteria
5. **Critical path** (which tasks will determine the final completion date)

## Constraints

- Never start planning before the goal is stated clearly enough to restate
- Always include at least one "review checkpoint" task for the human to validate direction before heavy execution begins
