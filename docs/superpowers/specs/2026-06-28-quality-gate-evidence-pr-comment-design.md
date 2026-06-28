# Quality Gate Evidence PR Comment

**Date:** 2026-06-28
**Status:** Approved

## Problem

When `requiredQualityGates` are configured (e.g. in `.zeroshot/settings.json`), validators collect evidence — the command run, exit code, and output — for each gate. This evidence gates the git-pusher handoff but is never surfaced anywhere visible. It exists only in the cluster's message bus and disappears after the cluster is cleaned up.

## Goal

After the git-pusher creates a PR/MR, post a comment containing the quality gate evidence collected by validators: gate ID, pass/fail status, command run, exit code, and truncated output. The comment should appear on all three supported platforms (GitHub, GitLab, Azure DevOps).

## Constraints

- Soft fail: if posting the comment fails, the agent logs the error and continues to the merge step. It must not output `blocked: true` because of this step.
- Output truncation: last 5 lines of output, capped at 500 characters. Append `[truncated]` if either limit was applied.
- Only runs when `requiredQualityGates.length > 0`. Repos with no configured gates see no change.
- No new infrastructure — uses the existing `triggeringMessage` data conduit and `generatePrompt` conditional step pattern.

## Architecture

### Data flow

```
validator VALIDATION_RESULT message
  └─ content.data.qualityGates: [{id, status, evidence: {command, exitCode, output}}]
        │
        ▼
agent-context-sections.js  (new: buildQualityGateEvidenceSection)
  └─ Formats evidence as plain text, applies truncation
  └─ Appended to triggeringMessage section in agent context
        │
        ▼
git-pusher LLM agent  (sees evidence in its context)
  └─ STEP 5b: formats evidence as markdown, posts PR comment
  └─ Soft fail: continues to merge if comment fails
```

### Why this approach

The `SHARED_TRIGGER_SCRIPT` runs in a read-only VM sandbox (`ledger`, `cluster` read-only). It cannot write files or call `store.set()`. The `triggeringMessage` is already injected into the agent context via `buildTriggeringMessageSection` — extending it to surface `content.data.qualityGates` is the idiomatic path. `generatePrompt` already conditionalizes on `requiredQualityGates.length > 0` for other features (merge queue, close issue mode), making the conditional STEP 5b a natural fit.

## Component Specifications

### 1. `src/agent/agent-context-sections.js`

**New function:** `buildQualityGateEvidenceSection(qualityGates)`

Input: array of quality gate objects from `triggeringMessage.content.data.qualityGates`.

Output format (plain text, appended after existing `content.text` block):

```
Quality Gate Evidence:
- [tests] PASS | exit=0 | cmd: pip install -e '.[dev]' -q && pytest
  output:
  32 passed in 1.72s

- [lint] FAIL | exit=1 | cmd: pip install -e '.[dev]' -q && ruff check .
  output:
  src/foo.py:10:1: E302 expected 2 blank lines
  [truncated]
```

**Truncation logic (applied per gate):**

1. Split output on newlines, take the last 5 lines.
2. Join and take the last 500 characters of the result.
3. If either limit was applied, append `[truncated]` on a new line.
4. If output is empty or missing, omit the `output:` block.

**Integration:** Call `buildQualityGateEvidenceSection` from `buildTriggeringMessageSection` when `triggeringMessage.content?.data?.qualityGates` is a non-empty array.

**Returns empty string when:**

- `qualityGates` is absent, null, or not an array.
- The array is empty.

### 2. `src/agents/git-pusher-template.js`

#### `getPlatformConfig` — new `commentCmd` field

Each platform entry gains a `commentCmd` string used in the new STEP 5b:

| Platform       | Command                                                                      |
| -------------- | ---------------------------------------------------------------------------- |
| `github`       | `gh pr comment "$(gh pr view --json number --jq .number)" --body "..."`      |
| `gitlab`       | `glab mr note "$(glab mr view --output json \| jq -r .iid)" --message "..."` |
| `azure-devops` | `az repos pr thread create --pull-request-id <PR_ID> --comment "..."`        |

Azure uses `<PR_ID>` — consistent with the existing pattern where the agent extracts the PR ID from STEP 5 output.

#### `generatePrompt` — new STEP 5b

Inserted between STEP 5 (create PR) and STEP 6 (merge). Conditionally included only when `requiredQualityGates.length > 0`:

```
### STEP 5b: Post quality gate evidence comment (soft fail — do NOT block on failure)
Using the "Quality Gate Evidence" section from your context, post a comment to the PR.
Format it as a markdown table with a collapsible output block per gate:

## Quality Gate Evidence
| Gate | Status | Exit | Command |
|------|--------|------|---------|
| <id> | ✅ PASS / ❌ FAIL / ⚠️ UNAVAILABLE | <exit> | `<command>` |

<details><summary><id> output</summary>

```

<truncated output from context>
```

</details>

Run:

```bash
<platform commentCmd with body constructed from context evidence>
```

If this command fails for any reason, print the error and continue immediately to STEP 6.
Do NOT set blocked: true because of this step.

```

#### CRITICAL RULES update

One new bullet added:
```

- STEP 5b is soft-fail — if the comment post fails, continue to STEP 6 regardless

```

## Testing

### Unit tests (existing test file: `tests/required-quality-gates-context.test.js`)

- `buildQualityGateEvidenceSection` with a passing gate: output contains gate ID, status, command, exit code, and truncated output.
- `buildQualityGateEvidenceSection` with a failing gate: status shows FAIL, output block present.
- Truncation: output > 5 lines is truncated to last 5 lines; output > 500 chars is capped and marked `[truncated]`.
- Empty/null qualityGates returns empty string.
- Output absent: no `output:` block rendered.

### Unit tests (`tests/structuredOutput-mapping.test.js` or new file)

- `getPlatformConfig('github', ...)` includes `commentCmd` containing `gh pr comment`.
- `getPlatformConfig('gitlab', ...)` includes `commentCmd` containing `glab mr note`.
- `getPlatformConfig('azure-devops', ...)` includes `commentCmd` containing `az repos pr thread create`.
- `generatePrompt` with `requiredQualityGates: []` does NOT include `STEP 5b`.
- `generatePrompt` with `requiredQualityGates: [{id: 'tests'}]` DOES include `STEP 5b`.

## Out of Scope

- Posting evidence when `requiredQualityGates` is empty (no-op for unconfigured repos).
- Retrying the comment post on failure.
- Including validator `criteriaResults` beyond the `qualityGates` array.
- Evidence from non-passing clusters (git-pusher only fires when all gates pass).
```
