const assert = require('assert');

const { validateAgentConfig } = require('../src/agent/agent-config');
const { buildContext } = require('../src/agent/agent-context-builder');
const { buildQualityGateEvidenceSection } = require('../src/agent/agent-context-sections');

function baseContextParams(config) {
  return {
    id: config.id,
    role: config.role,
    iteration: 1,
    config,
    messageBus: { query: () => [] },
    cluster: { id: 'test-cluster', createdAt: Date.now() - 60000 },
    triggeringMessage: { topic: 'IMPLEMENTATION_READY', sender: 'worker' },
  };
}

describe('required handoff quality gate context', function () {
  it('adds reusable command proof instructions for implementation agents', function () {
    const config = validateAgentConfig({
      id: 'worker',
      role: 'implementation',
      outputFormat: 'json',
      commandProofs: [
        {
          id: 'opcore-ci',
          profile: 'ci-equivalent',
          scope: 'repo',
          description: 'Opcore local CI',
          command: 'bash ./scripts/ci/run-local-ci-equivalent.sh',
        },
      ],
      prompt: 'Do the work.',
    });

    const context = buildContext(baseContextParams(config));

    assert.match(context, /Reusable Command Proofs/);
    assert.match(context, /id: opcore-ci, profile: ci-equivalent, scope: repo/);
    assert.match(context, /bash \.\/scripts\/ci\/run-local-ci-equivalent\.sh/);
    assert.match(context, /zeroshot cmdproof check opcore-ci/);
  });

  it('adds generic configured gate instructions and schema for validators', function () {
    const config = validateAgentConfig({
      id: 'validator',
      role: 'validator',
      outputFormat: 'json',
      jsonSchema: {
        type: 'object',
        properties: {
          approved: { type: 'boolean' },
        },
        required: ['approved'],
      },
      requiredQualityGates: [
        {
          id: 'repo-quality',
          scope: 'workspace',
          description: 'Run the configured workspace quality gate',
          command: 'quality-check --scope workspace',
          profile: 'ci-equivalent',
          commandProof: true,
        },
      ],
    });

    const context = buildContext(baseContextParams(config));

    assert.ok(config.jsonSchema.properties.qualityGates, 'schema should accept qualityGates');
    assert.deepStrictEqual(
      config.jsonSchema.properties.qualityGates.items.properties.evidence.required,
      ['command', 'exitCode', 'output']
    );
    assert.ok(
      config.jsonSchema.properties.qualityGates.items.properties.evidence.properties.proof,
      'schema should accept optional cmdproof evidence metadata'
    );
    assert.match(context, /Required Handoff Quality Gates/);
    assert.match(context, /id: repo-quality, scope: workspace/);
    assert.match(context, /Run the configured workspace quality gate/);
    assert.match(context, /quality-check --scope workspace/);
    assert.match(context, /zeroshot cmdproof check repo-quality/);
    assert.match(context, /publish one `qualityGates` entry/);
    assert.match(context, /approved` to false and publish status `FAIL`/);
    assert.match(context, /approved` to false and publish status `UNAVAILABLE`/);
  });

  it('does not add handoff gate instructions or schema when no gate is configured', function () {
    const config = validateAgentConfig({
      id: 'validator',
      role: 'validator',
      outputFormat: 'json',
      jsonSchema: {
        type: 'object',
        properties: {
          approved: { type: 'boolean' },
        },
        required: ['approved'],
      },
    });

    const context = buildContext(baseContextParams(config));

    assert.strictEqual(config.jsonSchema.properties.qualityGates, undefined);
    assert.ok(!context.includes('Required Handoff Quality Gates'));
  });
});

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

describe('buildTriggeringMessageSection with qualityGates', function () {
  it('includes quality gate evidence when qualityGates present in content.data', function () {
    const { buildTriggeringMessageSection } = require('../src/agent/agent-context-sections');
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
    const { buildTriggeringMessageSection } = require('../src/agent/agent-context-sections');
    const msg = {
      topic: 'VALIDATION_RESULT',
      sender: 'validator',
      content: { text: 'approved' },
    };
    const result = buildTriggeringMessageSection(msg);
    assert.ok(!result.includes('Quality Gate Evidence:'));
  });

  it('omits evidence block when qualityGates is an empty array', function () {
    const { buildTriggeringMessageSection } = require('../src/agent/agent-context-sections');
    const msg = {
      topic: 'VALIDATION_RESULT',
      sender: 'validator',
      content: { data: { qualityGates: [] } },
    };
    const result = buildTriggeringMessageSection(msg);
    assert.ok(!result.includes('Quality Gate Evidence:'));
  });
});
