import assert from 'node:assert/strict';
import test from 'node:test';
import { HANDOFF_TTL_MS, appPath, handoffId, isExpired, withoutHandoff } from '../src/handoff/index.js';

test('the handoff id is read from the hash, alone or beside other parameters', () => {
  assert.equal(handoffId('#handoff=4f1c'), '4f1c');
  assert.equal(handoffId('handoff=4f1c'), '4f1c');
  assert.equal(handoffId('#view=axial&handoff=4f1c'), '4f1c');
  assert.equal(handoffId(''), null);
  assert.equal(handoffId('#handoff='), null);
  assert.equal(handoffId('#example=t1'), null);
});

test('removing the handoff keeps every other fragment parameter as written', () => {
  assert.equal(withoutHandoff('#handoff=4f1c'), '');
  assert.equal(withoutHandoff('#view=axial&handoff=4f1c&q=a%20b'), '#view=axial&q=a%20b');
  assert.equal(withoutHandoff('#handoff&view=axial'), '#view=axial');
  assert.equal(withoutHandoff(''), '');
});

test('an entry expires two minutes after it was sent, or when the clock runs behind it', () => {
  const createdAt = 1_000_000;
  assert.equal(HANDOFF_TTL_MS, 120_000);
  assert.equal(isExpired({ createdAt }, createdAt), false);
  assert.equal(isExpired({ createdAt }, createdAt + HANDOFF_TTL_MS - 1), false);
  assert.equal(isExpired({ createdAt }, createdAt + HANDOFF_TTL_MS), true);
  assert.equal(isExpired({ createdAt }, createdAt - 1), true);
  assert.equal(isExpired({}, createdAt), true, 'an entry without a time is never kept');
});

test('the app path is the base directory a sender names as its target', () => {
  assert.equal(appPath('https://webapps.neurodesk.org/white-matter-lesions/'), 'white-matter-lesions');
  assert.equal(appPath('https://webapps.neurodesk.org/white-matter-lesions/index.html#handoff=1'), 'white-matter-lesions');
  assert.equal(appPath('http://127.0.0.1:4000/preview/site/dicomview/?x=1'), 'dicomview');
  assert.equal(appPath('http://127.0.0.1:4000/'), '');
});
