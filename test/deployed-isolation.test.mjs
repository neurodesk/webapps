import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { waitForAppIsolation } from '../test-utils/deployed-isolation.mjs';

test('deployed isolation keeps the strict predicate and 30-second wait', async () => {
  let calls = 0;
  const page = {
    async waitForFunction(predicate, arg, options) {
      calls++;
      assert.equal(arg, null);
      assert.deepEqual(options, { timeout: 30000 });
      for (const value of [false, undefined, 1, 'true', true]) {
        assert.equal(runInNewContext(`(${predicate})()`, {
          window: { crossOriginIsolated: value },
        }), value === true);
      }
    },
  };
  await waitForAppIsolation(page, 'topofit', 'https://example.test/topofit/');
  assert.equal(calls, 1);
});

for (const message of ['Timeout 30000ms exceeded.', 'Target page has been closed']) {
  test(`deployed isolation identifies the app and URL on ${message}`, async () => {
    const cause = new Error(message);
    let calls = 0;
    const page = {
      async waitForFunction() {
        calls++;
        throw cause;
      },
    };
    await assert.rejects(
      waitForAppIsolation(page, 'topofit', 'https://example.test/webapps/topofit/'),
      error => {
        assert.equal(error.message,
          'topofit: cross-origin isolation check failed at https://example.test/webapps/topofit/');
        assert.equal(error.cause, cause);
        return true;
      },
    );
    assert.equal(calls, 1);
  });
}
