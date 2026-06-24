'use strict';

/**
 * Tests for git-pusher branch guard.
 *
 * Root cause of issue: the git-pusher LLM ran in a worktree on
 * `zeroshot/<cluster-id>` but nothing in the prompt told it what branch it
 * was on. The LLM deviated and pushed directly to `origin/main`, bypassing
 * the PR flow entirely.
 *
 * Fixes:
 *  1. `gh pr create` now includes `--head "$(git branch --show-current)"` so
 *     the source branch is always explicit and `gh` will error if HEAD is the
 *     default branch.
 *  2. STEP 4 now includes a branch check that outputs blocked JSON when the
 *     agent is on the default branch.
 */

const assert = require('node:assert');
const { generateGitPusherAgent } = require('../../src/agents/git-pusher-template');

describe('git-pusher branch guard', function () {
  describe('gh pr create includes --head flag', function () {
    it('includes --head "$(git branch --show-current)" in the GitHub create command', function () {
      const agent = generateGitPusherAgent('github');
      assert.match(
        agent.prompt,
        /gh pr create --head "\$\(git branch --show-current\)"/,
        'gh pr create must specify --head so the source branch is always explicit'
      );
    });

    it('still includes --base when prBase is configured', function () {
      const agent = generateGitPusherAgent('github', { prBase: 'develop' });
      assert.match(
        agent.prompt,
        /gh pr create --head "\$\(git branch --show-current\)" --base develop/,
        'prBase must appear after --head, not before'
      );
    });

    it('does not include --base when prBase is explicitly null and no repo settings exist', function () {
      // resolveGitHubConfig reads repo settings from cwd; pass a temp dir with no settings
      // to test the no-prBase code path without the local .zeroshot/settings.json interfering.
      const os = require('node:os');
      const agent = generateGitPusherAgent('github', { prBase: null, cwd: os.tmpdir() });
      assert.doesNotMatch(
        agent.prompt,
        /gh pr create.*--base/,
        'no --base flag expected when prBase is not set and no repo settings exist'
      );
    });
  });

  describe('step 4 branch guard', function () {
    it('checks current branch before pushing', function () {
      const agent = generateGitPusherAgent('github');
      assert.match(
        agent.prompt,
        /CURRENT_BRANCH="\$\(git branch --show-current\)"/,
        'step 4 must capture the current branch name'
      );
    });

    it('compares current branch against the default branch', function () {
      const agent = generateGitPusherAgent('github');
      assert.match(
        agent.prompt,
        /DEFAULT_BRANCH=.*gh repo view/,
        'step 4 must resolve the actual default branch from gh rather than hard-coding "main"'
      );
    });

    it('outputs a BLOCKED message when on the default branch', function () {
      const agent = generateGitPusherAgent('github');
      assert.match(
        agent.prompt,
        /BLOCKED.*default branch/i,
        'step 4 must output a BLOCKED message when the current branch equals the default branch'
      );
    });

    it('instructs agent not to push when on the default branch', function () {
      const agent = generateGitPusherAgent('github');
      assert.match(
        agent.prompt,
        /Do NOT push if the current branch is the default branch/,
        'critical rules section must warn against pushing from the default branch'
      );
    });
  });

  describe('gitlab prompt is unaffected', function () {
    it('gitlab createCmd does not gain a --head flag (no such flag in glab)', function () {
      const agent = generateGitPusherAgent('gitlab');
      assert.doesNotMatch(
        agent.prompt,
        /glab mr create.*--head/,
        'glab mr create does not support --head; only gh pr create should have it'
      );
    });
  });
});
