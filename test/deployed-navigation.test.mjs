import assert from 'node:assert/strict';
import test from 'node:test';
import { navigateDeployed } from '../test-utils/deployed-navigation.mjs';

function pageWith(replies) {
  let calls = 0;
  return {
    get calls() { return calls; },
    async goto() {
      const value = replies[Math.min(calls++, replies.length - 1)];
      if (value instanceof Error) throw value;
      return { ok: () => value === 200, status: () => value };
    },
  };
}

test('deployment readiness recovers with bounded exponential waits', async () => {
  const page = pageWith([503, new Error('net::ERR_NAME_NOT_RESOLVED'), 200]);
  const waits = [];
  await navigateDeployed(page, 'https://site/app/', { delay: async ms => waits.push(ms) });
  assert.deepEqual(waits, [1000, 2000]);
  assert.equal(page.calls, 3);
});

test('persistent unavailability stops and 404s or browser errors fail immediately', async () => {
  for (const [reply, calls] of [[503, 4], [404, 1], [new Error('Target page closed'), 1]]) {
    const page = pageWith([reply]);
    await assert.rejects(navigateDeployed(page, 'https://site/app/', { delay: async () => {} }));
    assert.equal(page.calls, calls);
  }
});
