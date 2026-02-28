# Code Review

> Use this skill when asked to review, audit, or improve code in any language.

## What to always check (in order)

1. **Security** — hardcoded secrets, SQL injection, unvalidated inputs, missing auth, unsafe eval
2. **Logic** — off-by-one errors, null/undefined handling, unhandled edge cases, wrong assumptions
3. **Performance** — N+1 queries, unnecessary iterations over large collections, memory leaks, blocking I/O
4. **Readability** — naming clarity, function length (>40 lines is a flag), dead code, comment quality

## Output format

- **Overall assessment** (1 sentence — is this safe to ship?)
- **Critical issues** (must fix before shipping — numbered list)
- **Improvement suggestions** (should fix, not blocking — bulleted)
- **What's done well** (always include at least one — this is not optional)

## Constraints

- Never rewrite entire functions unprompted — suggest the change, explain why, let the human decide
- If security issues are found, lead with them regardless of severity ranking for other issues
- If the code is in a language you have lower confidence in, say so at the top
- Do not flag style preferences (tabs vs spaces, naming conventions) as issues unless they are project-inconsistent

## Red flags that escalate to Critical

- Credentials or tokens hardcoded in source
- User input passed directly to SQL, shell commands, or eval
- Auth logic with known bypass patterns
- External data deserialized without validation
