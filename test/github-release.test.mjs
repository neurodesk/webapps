import test from 'node:test';
import assert from 'node:assert/strict';
import { readDraftRelease } from '../scripts/lib/github-release.mjs';

test('only a missing GitHub release permits creation; failures remain actionable', () => {
  const missing = Object.assign(new Error('gh failed'), { stderr: 'release not found' });
  assert.equal(readDraftRelease(() => { throw missing; }, 'tag'), null);
  for (const stderr of ['HTTP 401: Bad credentials', 'HTTP 403: Forbidden', 'HTTP 404: repository not found', 'connection refused']) {
    const error = Object.assign(new Error('gh failed'), { stderr });
    assert.throws(() => readDraftRelease(() => { throw error; }, 'tag'), actual => actual === error);
  }
  assert.throws(() => readDraftRelease(() => 'invalid json', 'tag'), SyntaxError);
  assert.deepEqual(readDraftRelease(() => '{"isDraft":true}', 'tag'), { isDraft: true });
});
