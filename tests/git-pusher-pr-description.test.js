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
});
