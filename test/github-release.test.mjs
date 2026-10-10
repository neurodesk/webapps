import test from 'node:test';
import { execFileSync } from 'node:child_process';
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


test('default execFileSync options preserve release stderr and child exit status', () => {
  const gh = () => execFileSync(process.execPath, ['-e', 'process.stderr.write("release not found"); process.exit(1);'], { encoding: 'utf8' }).trim();
  assert.equal(readDraftRelease(gh, 'new-tag'), null);
  assert.throws(() => execFileSync(process.execPath, ['-e', 'process.exit(1);'], { encoding: 'utf8' }), error => error.status === 1);
});
