#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { formatFailureSummary, parseTestFailures } = require('./summarize_test_failures.cjs');

const fixtureParityLog = `
> test:fixtures
> node scripts/test_fixture_parity_outputs.cjs

{"id":"batch_t2s_deepseg_spinalcord","expectedNz":8724,"producedNz":0,"dice":0}
node:internal/assert/utils:77
AssertionError [ERR_ASSERTION]: batch_t2s_deepseg_spinalcord: foreground 0 is within tolerance of 8724
    at Object.<anonymous> (/repo/scripts/test_fixture_parity_outputs.cjs:228:10)
`;

const parsed = parseTestFailures(fixtureParityLog, { exitCode: 1 });
assert.equal(parsed.exitCode, '1');
assert.equal(parsed.failures.length, 1);
assert.deepEqual(parsed.failures[0], {
  script: 'test:fixtures',
  testName: 'batch_t2s_deepseg_spinalcord',
  message: 'batch_t2s_deepseg_spinalcord: foreground 0 is within tolerance of 8724'
});

const markdown = formatFailureSummary(parsed);
assert.match(markdown, /Exit code: `1`/);
assert.match(markdown, /script `test:fixtures`, test `batch_t2s_deepseg_spinalcord`/);
assert.match(markdown, /Recent log tail:/);

const genericLog = `
> test:worker:protocol
> node scripts/test_inference_worker_protocol.cjs

Error: terminal message emitted twice
`;

const generic = parseTestFailures(genericLog);
assert.equal(generic.failures.length, 1);
assert.equal(generic.failures[0].script, 'test:worker:protocol');
assert.equal(generic.failures[0].testName, '');
assert.equal(generic.failures[0].message, 'Error: terminal message emitted twice');

console.log('summarize_test_failures tests passed');
