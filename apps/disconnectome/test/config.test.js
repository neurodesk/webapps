// DOM-independent unit tests (Node, no browser). Browser behaviour is covered in e2e/.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { APP, ATLAS, GRID, TRACTS, assignInputs, damagedBundles } from '../src/config.js';
import examples from '../examples.json' with { type: 'json' };

test('app id is lowercase kebab-case and the config is frozen', () => {
  assert.match(APP.id, /^[a-z][a-z0-9-]*$/);
  assert.ok(Object.isFrozen(APP) && Object.isFrozen(ATLAS) && Object.isFrozen(TRACTS));
});

test('every asset URL is pinned to an immutable dataset revision', () => {
  const pinned = /\/resolve\/[0-9a-f]{40}\/disconnectome\//;
  for (const asset of [ATLAS, TRACTS]) {
    assert.match(asset.url, pinned, `${asset.filename} is not pinned`);
    assert.match(asset.sha256, /^[0-9a-f]{64}$/);
    assert.ok(asset.bytes > 0);
  }
  for (const file of examples.flatMap((example) => example.files)) {
    assert.match(file.url, pinned, `${file.name} is not pinned`);
    assert.match(file.sha256, /^[0-9a-f]{64}$/);
  }
  // The browser fetches the gzipped atlas; the 88 MB plain copy is not served.
  assert.ok(ATLAS.filename.endsWith('.tvx.gz'));
  assert.deepEqual(GRID.dim, [182, 218, 182]);
});

test('the three examples each pair a lesion with its own anatomical scan', () => {
  assert.deepEqual(examples.map((example) => example.id), ['wm2017', 'wm2018', 'wm2208']);
  for (const example of examples) {
    const [lesion, anatomical] = example.files;
    assert.equal(lesion.role, 'image');
    assert.ok(lesion.name.includes('_lesion'));
    assert.equal(anatomical.role, 'anatomical');
    assert.ok(!anatomical.name.includes('_lesion'));
    // The selector hands both files to assignInputs, which picks the lesion by name.
    assert.equal(assignInputs(example.files.map((file) => ({ name: file.name, size: 1 }))).lesion.name, lesion.name);
  }
});

test('a dropped selection picks the lesion, not the scan', () => {
  const file = (name, size) => ({ name, size });
  const scan = file('wM2208_T1w.nii.gz', 5022139);
  const mask = file('wM2208_T1w_lesion.nii.gz', 11085);

  assert.deepEqual(assignInputs([mask]), { lesion: mask, anatomical: null });
  assert.deepEqual(assignInputs([scan, mask]), { lesion: mask, anatomical: scan });
  assert.deepEqual(assignInputs([mask, scan]), { lesion: mask, anatomical: scan });
  // No "lesion" in either name: fall back to the smaller file.
  const a = file('a.nii.gz', 900), b = file('b.nii.gz', 90);
  assert.deepEqual(assignInputs([a, b]), { lesion: b, anatomical: a });
  // Both named lesion: the name rule is ambiguous, so size decides.
  const l1 = file('lesion1.nii.gz', 900), l2 = file('lesion2.nii.gz', 90);
  assert.equal(assignInputs([l1, l2]).lesion, l2);
  assert.ok(assignInputs([file('notes.txt', 10)]).error);
});

test('damaged bundles are filtered, sorted worst first, and never include NaN', () => {
  const tracts = ['AF_L', 'CST_L', 'IFOF_L', 'empty'];
  const fractions = Float32Array.from([0.5, 0.1, 1, NaN]);

  assert.deepEqual(damagedBundles(tracts, fractions, 0).map((r) => r.name), ['IFOF_L', 'AF_L', 'CST_L']);
  assert.deepEqual(damagedBundles(tracts, fractions, 0.5).map((r) => r.name), ['IFOF_L', 'AF_L']);
  assert.deepEqual(damagedBundles(tracts, fractions, 1).map((r) => r.name), ['IFOF_L']);
  // An empty tract is missing data, not zero damage, so it is never drawn.
  assert.ok(!damagedBundles(tracts, fractions, 0).some((r) => r.name === 'empty'));
});
