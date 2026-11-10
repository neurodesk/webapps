import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('the served notice is NOTICE and the cellfinder licence, and states the atlas terms', () => {
  const notice = read('../NOTICE');
  assert.equal(read('../public/THIRD_PARTY_NOTICES.txt'), `${notice}\n${read('../LICENSE-cellfinder')}`);
  // Both offline inventories bundle the atlas, so the notice must not say it is never bundled.
  assert.doesNotMatch(notice, /not bundled/);
  assert.match(notice, /offline \(Standalone\) bundles include it/);
  assert.match(notice, /research and noncommercial use only/);
  assert.match(notice, /commercial redistribution of an offline bundle that contains it, needs the Allen Institute's\nprior written permission/);
  assert.match(notice, /Allen Institute for Brain Science \(2017\)\. Allen Mouse Brain Common Coordinate Framework,\nversion 3 \[dataset\]/);
  const offline = JSON.parse(read('../../../registry/offline-assets.sources.json'));
  assert.ok(JSON.stringify(offline).includes('lightsheet-atlas/atlas/allen_mouse_50um_annotation.nii.gz'));
});
