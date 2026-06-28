'use strict';

const assert = require('assert');
const { getPlatformConfig } = require('../src/agents/git-pusher-template');

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
