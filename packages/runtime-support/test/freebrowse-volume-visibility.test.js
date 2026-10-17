import assert from 'node:assert/strict';
import test from 'node:test';
import { bindVolumeVisibility } from '../src/freebrowse-viewer/volume-visibility.js';

// NiiVue's setVolume as rc.17 implements it: assign the changes, emit volumeUpdated.
function fakeNiiVue(opacity) {
  const nv = new EventTarget();
  nv.volumes = [{ name: 't1', opacity }];
  nv.setVolume = async (volumeIndex, changes) => {
    Object.assign(nv.volumes[volumeIndex], changes);
    nv.dispatchEvent(new CustomEvent('volumeUpdated', { detail: { volumeIndex, volume: nv.volumes[volumeIndex], changes } }));
  };
  return nv;
}

test('hiding a volume clears its opacity and showing it restores the previous value', async () => {
  const nv = fakeNiiVue(0.6);
  bindVolumeVisibility(nv);
  await nv.setVolume(0, { visible: false });
  assert.equal(nv.volumes[0].opacity, 0);
  await nv.setVolume(0, { visible: true });
  assert.equal(nv.volumes[0].opacity, 0.6);
});

test('showing a volume the user faded to 0 leaves it at 0', async () => {
  const nv = fakeNiiVue(0);
  bindVolumeVisibility(nv);
  await nv.setVolume(0, { visible: false });
  await nv.setVolume(0, { visible: true });
  assert.equal(nv.volumes[0].opacity, 0);
});

test('released, the binding no longer touches opacity', async () => {
  const nv = fakeNiiVue(1);
  bindVolumeVisibility(nv)();
  await nv.setVolume(0, { visible: false });
  assert.equal(nv.volumes[0].opacity, 1);
});
