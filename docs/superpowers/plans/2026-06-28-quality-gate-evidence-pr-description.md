# Quality Gate Evidence in PR Description — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface quality gate evidence (commands, exit codes, truncated output) and an AI-generated change overview in the PR/MR description written by the git-pusher agent on all three supported platforms.

**Architecture:** A new `buildQualityGateEvidenceSection` function in `agent-context-sections.js` reads `qualityGates` from the triggering `VALIDATION_RESULT` message, truncates output, and injects it as plain text into the git-pusher's context. `generatePrompt` is updated to instruct the agent to collect a `git log`/`git diff --stat` overview, build a `$PR_BODY` heredoc containing the overview and quality gate section, and pass it to the platform `createCmd`. All three platform `createCmd` values switch from a hardcoded `"Closes #{{issue_number}}"` body to `"$PR_BODY"`.

**Tech Stack:** Node.js (CommonJS), Mocha (`npx mocha <file>`), no new dependencies.

## Global Constraints

- Output truncation: last 5 lines of gate output, then last 500 characters. If either limit was applied, append `[truncated]` on a new line.
- Quality gate section only included in the prompt when `requiredQualityGates.length > 0`.
- Overview section always included (even when no quality gates are configured).
- All three platforms must use `$PR_BODY` — no platform is left on the old `"Closes #..."` inline body.
- Soft-fail behavior does NOT apply — description construction is part of STEP 5, not a separate step.

---

### Task 1: `buildQualityGateEvidenceSection` — new function and unit tests

**Files:**

- Modify: `src/agent/agent-context-sections.js` (add two functions, extend exports)
- Test: `tests/required-quality-gates-context.test.js` (add `describe` block)

**Interfaces:**

- Produces: `buildQualityGateEvidenceSection(qualityGates: unknown): string` — exported from `agent-context-sections.js`. Returns `''` for null/empty input. Otherwise returns a plain-text block starting with `Quality Gate Evidence:\n`.

---

- [ ] **Step 1: Add failing tests**

Open `tests/required-quality-gates-context.test.js`. After the existing `require` lines at the top, add:

```js
const { buildQualityGateEvidenceSection } = require('../src/agent/agent-context-sections');
```

Then add the following `describe` block at the bottom of the file (after the closing `});` of the existing `describe`):

```js
describe('buildQualityGateEvidenceSection', function () {
  it('returns empty string for null input', function () {
    assert.strictEqual(buildQualityGateEvidenceSection(null), '');
  });

  it('returns empty string for empty array', function () {
    assert.strictEqual(buildQualityGateEvidenceSection([]), '');
  });

  it('formats a passing gate with full evidence', function () {
    const gates = [
      {
        id: 'tests',
        status: 'PASS',
        evidence: { command: 'pytest', exitCode: 0, output: '32 passed in 1.72s' },
      },
    ];
    const result = buildQualityGateEvidenceSection(gates);
    assert.match(result, /Quality Gate Evidence:/);
    assert.match(result, /\[tests\] PASS/);
    assert.match(result, /exit=0/);
    assert.match(result, /cmd: pytest/);
    assert.match(result, /32 passed in 1\.72s/);
    assert.ok(!result.includes('[truncated]'));
  });

  it('formats a failing gate', function () {
    const gates = [
      {
        id: 'lint',
        status: 'FAIL',
        evidence: { command: 'ruff check .', exitCode: 1, output: 'E302 error' },
      },
    ];
    const result = buildQualityGateEvidenceSection(gates);
    assert.match(result, /\[lint\] FAIL/);
    assert.match(result, /exit=1/);
  });

  it('omits output block when output is absent', function () {
    const gates = [{ id: 'tests', status: 'PASS', evidence: { command: 'pytest', exitCode: 0 } }];
    const result = buildQualityGateEvidenceSection(gates);
    assert.ok(!result.includes('output:'));
  });

  it('truncates output longer than 5 lines to last 5 lines and marks [truncated]', function () {
    const output = ['line1', 'line2', 'line3', 'line4', 'line5', 'line6', 'line7'].join('\n');
    const gates = [{ id: 'tests', status: 'PASS', evidence: { exitCode: 0, output } }];
    const result = buildQualityGateEvidenceSection(gates);
    assert.ok(!result.includes('line1'));
    assert.ok(!result.includes('line2'));
    assert.match(result, /line3/);
    assert.match(result, /line7/);
    assert.match(result, /\[truncated\]/);
  });

  it('truncates output longer than 500 chars to last 500 chars and marks [truncated]', function () {
    const output = 'x'.repeat(600);
    const gates = [{ id: 'tests', status: 'PASS', evidence: { exitCode: 0, output } }];
    const result = buildQualityGateEvidenceSection(gates);
    assert.match(result, /\[truncated\]/);
    // The 500-char slice of 'xxx...' should be present; the full 600 should not be
    const outputSection = result.split('output:')[1] || '';
    assert.ok(outputSection.replace(/\s|\[truncated\]/g, '').length <= 500);
  });

  it('renders multiple gates in order', function () {
    const gates = [
      { id: 'tests', status: 'PASS', evidence: { exitCode: 0, output: 'ok' } },
      { id: 'lint', status: 'PASS', evidence: { exitCode: 0, output: 'clean' } },
    ];
    const result = buildQualityGateEvidenceSection(gates);
    assert.ok(result.indexOf('[tests]') < result.indexOf('[lint]'));
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npx mocha tests/required-quality-gates-context.test.js
```

Expected: errors including `TypeError: buildQualityGateEvidenceSection is not a function`.

- [ ] **Step 3: Implement `truncateGateOutput` and `buildQualityGateEvidenceSection`**

In `src/agent/agent-context-sections.js`, add the following two functions **before** `buildTriggeringMessageSection` (around line 314):

```js
function truncateGateOutput(output) {
  if (typeof output !== 'string' || output.trim() === '') return null;
  const lines = output.split('\n');
  let truncated = false;
  let result;
  if (lines.length > 5) {
    result = lines.slice(-5).join('\n');
    truncated = true;
  } else {
    result = output;
  }
  if (result.length > 500) {
    result = result.slice(-500);
    truncated = true;
  }
  return { text: result, truncated };
}

function buildQualityGateEvidenceSection(qualityGates) {
  if (!Array.isArray(qualityGates) || qualityGates.length === 0) return '';
  const parts = ['Quality Gate Evidence:'];
  for (const gate of qualityGates) {
    const id =
      (typeof gate?.id === 'string' && gate.id.trim()) ||
      (typeof gate?.name === 'string' && gate.name.trim()) ||
      'unknown';
    const status = String(gate?.status || 'UNKNOWN').toUpperCase();
    const evidence = gate?.evidence && typeof gate.evidence === 'object' ? gate.evidence : {};
    const headerParts = [`- [${id}] ${status}`];
    if (evidence.exitCode !== undefined) headerParts.push(`exit=${evidence.exitCode}`);
    if (typeof evidence.command === 'string' && evidence.command.trim()) {
      headerParts.push(`cmd: ${evidence.command}`);
    }
    parts.push(headerParts.join(' | '));
    const truncated = truncateGateOutput(evidence.output);
    if (truncated) {
      parts.push('  output:');
      for (const line of truncated.text.split('\n')) {
        parts.push(`  ${line}`);
      }
      if (truncated.truncated) parts.push('  [truncated]');
    }
    parts.push('');
  }
  return parts.join('\n');
}
```

Then add `buildQualityGateEvidenceSection` to the `module.exports` at the bottom of the file:

```js
module.exports = {
  buildHeaderContext,
  buildInstructionsSection,
  buildJsonSchemaSection,
  buildLegacyOutputSchemaSection,
  buildRepoToolingSection,
  buildQualityGateEvidenceSection,
  buildTriggeringMessageSection,
  buildValidatorSkipSection,
};
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npx mocha tests/required-quality-gates-context.test.js
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/agent/agent-context-sections.js tests/required-quality-gates-context.test.js
git commit -m "feat: add buildQualityGateEvidenceSection with truncation"
```

---

### Task 2: Inject evidence into triggering message context

**Files:**

- Modify: `src/agent/agent-context-sections.js` (extend `buildTriggeringMessageSection`)
- Test: `tests/required-quality-gates-context.test.js` (add integration tests for `buildTriggeringMessageSection`)

**Interfaces:**

- Consumes: `buildQualityGateEvidenceSection` from Task 1
- Produces: `buildTriggeringMessageSection` now accepts `triggeringMessage.content.data.qualityGates` and appends the evidence block when non-empty. Signature unchanged.

---

- [ ] **Step 1: Add failing integration tests**

In `tests/required-quality-gates-context.test.js`, add the following `require` after the existing requires (if not already present):

```js
const { buildTriggeringMessageSection } = require('../src/agent/agent-context-sections');
```

Add a new `describe` block at the bottom of the file:

```js
describe('buildTriggeringMessageSection with qualityGates', function () {
  it('includes quality gate evidence when qualityGates present in content.data', function () {
    const msg = {
      topic: 'VALIDATION_RESULT',
      sender: 'validator',
      content: {
        data: {
          qualityGates: [
            {
              id: 'tests',
              status: 'PASS',
              evidence: { command: 'pytest', exitCode: 0, output: '32 passed' },
            },
          ],
        },
      },
    };
    const result = buildTriggeringMessageSection(msg);
    assert.match(result, /Quality Gate Evidence:/);
    assert.match(result, /\[tests\] PASS/);
    assert.match(result, /32 passed/);
  });

  it('omits evidence block when qualityGates is absent', function () {
    const msg = {
      topic: 'VALIDATION_RESULT',
      sender: 'validator',
      content: { text: 'approved' },
    };
    const result = buildTriggeringMessageSection(msg);
    assert.ok(!result.includes('Quality Gate Evidence:'));
  });

  it('omits evidence block when qualityGates is an empty array', function () {
    const msg = {
      topic: 'VALIDATION_RESULT',
      sender: 'validator',
      content: { data: { qualityGates: [] } },
    };
    const result = buildTriggeringMessageSection(msg);
    assert.ok(!result.includes('Quality Gate Evidence:'));
  });
});
```

- [ ] **Step 2: Run tests to confirm new tests fail**

```bash
npx mocha tests/required-quality-gates-context.test.js
```

Expected: 3 new failures (`Quality Gate Evidence:` not found or found when it shouldn't be).

- [ ] **Step 3: Extend `buildTriggeringMessageSection`**

In `src/agent/agent-context-sections.js`, replace the existing `buildTriggeringMessageSection` function (lines 314–328) with:

```js
function buildTriggeringMessageSection(triggeringMessage) {
  const lines = [
    '',
    '## Triggering Message',
    '',
    `Topic: ${triggeringMessage.topic}`,
    `Sender: ${triggeringMessage.sender}`,
  ];

  if (triggeringMessage.content?.text) {
    lines.push('', triggeringMessage.content.text);
  }

  const qualityGates = triggeringMessage.content?.data?.qualityGates;
  const evidenceSection = buildQualityGateEvidenceSection(qualityGates);
  if (evidenceSection) {
    lines.push('', evidenceSection);
  }

  return `${lines.join('\n')}\n`;
}
```

- [ ] **Step 4: Run all tests**

```bash
npx mocha tests/required-quality-gates-context.test.js
```

Expected: all tests pass.

- [ ] **Step 5: Run full test suite to check for regressions**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/agent/agent-context-sections.js tests/required-quality-gates-context.test.js
git commit -m "feat: inject quality gate evidence into triggering message context"
```

---

### Task 3: Update `getPlatformConfig` `createCmd` to use `$PR_BODY`

**Files:**

- Modify: `src/agents/git-pusher-template.js` (`getPlatformConfig` only — three `createCmd` strings)
- Test: `tests/git-pusher-pr-description.test.js` (new file)

**Interfaces:**

- Consumes: `getPlatformConfig` from `git-pusher-template.js` (already exported for testing via `generateGitPusherAgent`)
- Produces: `getPlatformConfig('github', ...)` returns config where `createCmd` contains `$PR_BODY` and no longer contains the old `"Closes #{{issue_number}}"` inline body; same for `'gitlab'` and `'azure-devops'`.

---

- [ ] **Step 1: Create failing test file**

Create `tests/git-pusher-pr-description.test.js`:

```js
'use strict';

const assert = require('assert');
const { getPlatformConfig, generateGitPusherAgent } = require('../src/agents/git-pusher-template');

describe('git-pusher PR description', function () {
  describe('getPlatformConfig createCmd uses $PR_BODY', function () {
    it('github createCmd uses $PR_BODY and not hardcoded body', function () {
      const config = getPlatformConfig('github', {});
      assert.ok(
        config.createCmd.includes('$PR_BODY'),
        `github createCmd should reference $PR_BODY, got: ${config.createCmd}`
      );
      assert.ok(
        !config.createCmd.includes('"Closes #{{issue_number}}"'),
        'github createCmd should not have old hardcoded body'
      );
    });

    it('github createCmd still contains --head and --title', function () {
      const config = getPlatformConfig('github', {});
      assert.match(config.createCmd, /--head/);
      assert.match(config.createCmd, /--title/);
    });

    it('gitlab createCmd uses $PR_BODY', function () {
      const config = getPlatformConfig('gitlab', {});
      assert.ok(
        config.createCmd.includes('$PR_BODY'),
        `gitlab createCmd should reference $PR_BODY, got: ${config.createCmd}`
      );
      assert.ok(!config.createCmd.includes('"Closes #{{issue_number}}"'));
    });

    it('azure-devops createCmd uses $PR_BODY', function () {
      const config = getPlatformConfig('azure-devops', {});
      assert.ok(
        config.createCmd.includes('$PR_BODY'),
        `azure-devops createCmd should reference $PR_BODY, got: ${config.createCmd}`
      );
      assert.ok(!config.createCmd.includes('"Closes #{{issue_number}}"'));
    });
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
npx mocha tests/git-pusher-pr-description.test.js
```

Expected: 4 failures — `$PR_BODY` not found in createCmd strings.

- [ ] **Step 3: Update the three `createCmd` values in `getPlatformConfig`**

In `src/agents/git-pusher-template.js`, update the `PLATFORM_CONFIGS` object inside `getPlatformConfig` (lines 357–406).

Replace the `github` `createCmd` line (line 361):

```js
// Before:
createCmd: `gh pr create --head "$(git branch --show-current)"${prBase ? ` --base ${prBase}` : ''} --title "feat: {{issue_title}}" --body "Closes #{{issue_number}}"`,

// After:
createCmd: `gh pr create --head "$(git branch --show-current)"${prBase ? ` --base ${prBase}` : ''} --title "feat: {{issue_title}}" --body "$PR_BODY"`,
```

Replace the `gitlab` `createCmd` (lines 380–381):

```js
// Before:
createCmd:
  'glab mr create --title "feat: {{issue_title}}" --description "Closes #{{issue_number}}"',

// After:
createCmd: 'glab mr create --title "feat: {{issue_title}}" --description "$PR_BODY"',
```

Replace the `azure-devops` `createCmd` (lines 391–392):

```js
// Before:
createCmd:
  'az repos pr create --title "feat: {{issue_title}}" --description "Closes #{{issue_number}}"',

// After:
createCmd: 'az repos pr create --title "feat: {{issue_title}}" --description "$PR_BODY"',
```

- [ ] **Step 4: Run target tests**

```bash
npx mocha tests/git-pusher-pr-description.test.js
```

Expected: all 4 tests pass.

- [ ] **Step 5: Run full suite**

```bash
npm test
```

Expected: all tests pass (the existing structuredOutput-mapping tests still pass because they don't assert on the body content).

- [ ] **Step 6: Commit**

```bash
git add src/agents/git-pusher-template.js tests/git-pusher-pr-description.test.js
git commit -m "feat: update createCmd to use \$PR_BODY on all three platforms"
```

---

### Task 4: Update `generatePrompt` — STEP 5 overview + quality gate body

**Files:**

- Modify: `src/agents/git-pusher-template.js` (`generatePrompt` signature + STEP 5 block + CRITICAL RULES; `generateGitPusherAgent` to thread `requiredQualityGates` through)
- Test: `tests/git-pusher-pr-description.test.js` (extend with new `describe` block)

**Interfaces:**

- Consumes: `requiredQualityGates: Array<{id: string}>` from `generateGitPusherAgent`
- Produces: `generatePrompt(config, requiredQualityGates = [])` — STEP 5 always contains git log/diff + overview instructions; when `requiredQualityGates.length > 0`, also contains quality gate body instructions. Prompt references `$PR_BODY` in the create command.

---

- [ ] **Step 1: Add failing tests**

In `tests/git-pusher-pr-description.test.js`, add the following `describe` block (after the existing one, inside the outer `describe`):

```js
describe('generatePrompt STEP 5 overview and quality gate body', function () {
  it('STEP 5 always contains git log and git diff instructions', function () {
    const agent = generateGitPusherAgent('github', {});
    assert.match(agent.prompt, /git log --oneline HEAD~5\.\.HEAD/);
    assert.match(agent.prompt, /git diff --stat HEAD~1/);
  });

  it('STEP 5 contains Overview heredoc instructions', function () {
    const agent = generateGitPusherAgent('github', {});
    assert.match(agent.prompt, /\$\{PR_BODY\}|\$PR_BODY/);
    assert.match(agent.prompt, /## Overview/);
    assert.match(agent.prompt, /EOFBODY/);
  });

  it('STEP 5 does NOT include quality gate section when no requiredQualityGates', function () {
    const agent = generateGitPusherAgent('github', { requiredQualityGates: [] });
    assert.ok(
      !agent.prompt.includes('Quality Gate Evidence'),
      'prompt should not mention Quality Gate Evidence when no gates configured'
    );
  });

  it('STEP 5 includes quality gate section when requiredQualityGates is set', function () {
    const agent = generateGitPusherAgent('github', {
      requiredQualityGates: [{ id: 'tests' }],
    });
    assert.match(agent.prompt, /Quality Gate Evidence/);
    assert.match(agent.prompt, /PASS \/ ❌ FAIL/);
  });

  it('CRITICAL RULES mentions PR_BODY construction', function () {
    const agent = generateGitPusherAgent('github', {});
    assert.match(agent.prompt, /PR_BODY/);
    assert.match(agent.prompt, /git log/);
  });
});
```

- [ ] **Step 2: Run to confirm failures**

```bash
npx mocha tests/git-pusher-pr-description.test.js
```

Expected: 5 new failures — prompt contains old STEP 5, no `git log`, no `Overview`, no quality gate section.

- [ ] **Step 3: Add `requiredQualityGates` parameter to `generatePrompt`**

In `src/agents/git-pusher-template.js`, change the `generatePrompt` function signature from:

```js
function generatePrompt(config) {
```

to:

```js
function generatePrompt(config, requiredQualityGates = []) {
```

- [ ] **Step 4: Add `qualityGateBodyInstructions` variable inside `generatePrompt`**

Inside `generatePrompt`, after the destructuring of `config` (after line 435), add:

```js
const hasQualityGates = Array.isArray(requiredQualityGates) && requiredQualityGates.length > 0;

const qualityGateBodyInstructions = hasQualityGates
  ? `
Include the quality gate evidence from the "Quality Gate Evidence" section of your context.
Format it as:

## Quality Gate Evidence

| Gate | Status | Exit | Command |
|------|--------|------|---------|
| <id> | ✅ PASS / ❌ FAIL / ⚠️ UNAVAILABLE | <exit> | \`<cmd>\` |

<details><summary><id> output</summary>

\`\`\`
<output from context>
\`\`\`

</details>
`
  : '';
```

- [ ] **Step 5: Replace STEP 5 block in the returned template string**

Inside the template string returned by `generatePrompt`, replace the existing STEP 5 block (lines 535–541):

```js
// BEFORE — remove this block:
`### STEP 5: CREATE THE ${prName.toUpperCase()} (MANDATORY - YOU MUST RUN THIS COMMAND)
\`\`\`bash
${createCmd}
\`\`\`
🚨 YOU MUST RUN \`${createCmd.split(' ').slice(0, 3).join(' ')}\`! Outputting a link is NOT creating a ${prName}! 🚨
The push output shows a "Create a ${prNameLower}" link - IGNORE IT.
You MUST run the \`${createCmd.split(' ').slice(0, 3).join(' ')}\` command above.${requiresPrIdExtraction ? '' : ` Save the actual ${prName} URL from the output.`}${azurePrIdNote}`;
```

```js
// AFTER — replace with:
`### STEP 5: CREATE THE ${prName.toUpperCase()} (MANDATORY - YOU MUST RUN THIS COMMAND)

First, collect the change overview:
\`\`\`bash
git log --oneline HEAD~5..HEAD
git diff --stat HEAD~1
\`\`\`
Use this output to write a 1–3 sentence summary of what was implemented.

Then construct the PR body and create the ${prName}:
\`\`\`bash
PR_BODY="$(cat <<'EOFBODY'
## Overview

<your 1-3 sentence summary here>

Closes #{{issue_number}}
${qualityGateBodyInstructions}
EOFBODY
)"
${createCmd}
\`\`\`
🚨 YOU MUST RUN \`${createCmd.split(' ').slice(0, 3).join(' ')}\`! Outputting a link is NOT creating a ${prName}! 🚨
The push output shows a "Create a ${prNameLower}" link - IGNORE IT.
You MUST run the \`${createCmd.split(' ').slice(0, 3).join(' ')}\` command above.${requiresPrIdExtraction ? '' : ` Save the actual ${prName} URL from the output.`}${azurePrIdNote}`;
```

- [ ] **Step 6: Add bullet to CRITICAL RULES**

Inside the template string, find the CRITICAL RULES section (around line 591). The list of bullets starts with `- Execute EVERY step in order`. Add one new bullet:

```js
// Add after the existing bullets, before the closing of the CRITICAL RULES section:
`- STEP 5 requires constructing $PR_BODY before running the create command — run git log/diff first to write the overview`;
```

The complete CRITICAL RULES section should look like:

```
## CRITICAL RULES
- Execute EVERY step in order (1, 2, 3, 4, 5, 6)
- Do NOT skip git add -A
- Do NOT skip git commit
- Do NOT push if the current branch is the default branch — check first and output blocked JSON if so
- Do NOT skip ${createCmd.split(' ').slice(0, 3).join(' ')} - THE TASK IS NOT DONE UNTIL ${prName} EXISTS
- Do NOT skip ${mergeCmd.split(' ').slice(0, 4).join(' ')} - attempt merge or auto-merge before reporting blocked
- STEP 5 requires constructing $PR_BODY before running the create command — run git log/diff first to write the overview
- Do NOT edit files after validator handoff
...
```

- [ ] **Step 7: Thread `requiredQualityGates` through `generateGitPusherAgent`**

In `generateGitPusherAgent` (around line 655), change:

```js
// BEFORE:
prompt: generatePrompt(platformConfig),

// AFTER:
prompt: generatePrompt(platformConfig, requiredQualityGates),
```

- [ ] **Step 8: Run target tests**

```bash
npx mocha tests/git-pusher-pr-description.test.js
```

Expected: all tests pass.

- [ ] **Step 9: Run full suite**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 10: Commit**

```bash
git add src/agents/git-pusher-template.js tests/git-pusher-pr-description.test.js
git commit -m "feat: STEP 5 builds PR description with overview and quality gate evidence"
```
