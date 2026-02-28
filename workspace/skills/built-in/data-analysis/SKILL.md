# Data Analysis

> Use this skill when analyzing CSV, JSON, spreadsheets, API responses, or any structured data.

## First pass — always do this before anything else

- How many rows/records? Any anomalies in count (much more or less than expected)?
- What are the column types? Any that look wrong for what they represent?
- What is the date range if this is time-series data?
- What percentage of values are null per column? (>5% null in a key column is a finding)

## Analysis approach

- **Start with distributions, not means.** Means hide skew, outliers, and bimodal patterns.
- **Look for the outliers first** — they are usually the most interesting part of the story.
- If comparing groups, verify group sizes are comparable before drawing conclusions.
- Correlation ≠ causation. If you surface a correlation, say it explicitly and suggest how to test causality.
- Negative findings are findings. "This variable does not correlate with outcome" is useful information.

## Output format

1. **Data summary**: rows, columns, time range if applicable, null counts for key columns
2. **Key finding** (1–2 sentences): the single most important thing this data shows
3. **Supporting analysis**: 3–5 bullets with specifics (numbers, %, not vague trends)
4. **Caveats**: data quality issues, missing values, what you can't conclude from this data
5. **Next question**: the most useful follow-up question to answer with this or related data

## Constraints

- Always include actual numbers, not just direction ("revenue is up" is not a finding; "revenue is up 23% vs. prior period" is)
- If the data quality is too poor to produce reliable findings, say so — do not produce unreliable analysis
- Do not produce visualizations unless explicitly asked; describe what a chart would show instead
