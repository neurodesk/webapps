import assert from 'node:assert/strict';
import test from 'node:test';
import { bindTouchGestures } from '../src/freebrowse-viewer/touch-gestures.js';

const DRAG = { crosshair: 8, pan: 3 };
const RENDER = 4;

class FakePointerEvent extends Event {
  constructor(type, { bubbles, cancelable, ...fields }) {
    super(type, { bubbles, cancelable: true });
    Object.assign(this, fields);
  }
}

// Node's EventTarget has no capture phase, so the adapter is bound before the
// stand-in for NiiVue's own listeners, which is the order a browser runs them.
function setup({ sliceType = 3, isRender = false, drawIsEnabled = false } = {}) {
  const canvas = new EventTarget();
  const nv = {
    primaryDragMode: DRAG.crosshair,
    sliceType,
    activeTileHit: { isRender },
    drawIsEnabled,
    scaleMultiplier: 1,
    pan2Dxyzmm: [1, 2, 3, 1],
  };
  const release = bindTouchGestures(nv, canvas, { dragModePan: DRAG.pan, sliceTypeRender: RENDER }, (type, init) => new FakePointerEvent(type, init));
  const seen = [];
  for (const type of ['pointerdown', 'pointermove', 'pointerup']) {
    canvas.addEventListener(type, (event) => seen.push([type, event.pointerType, event.clientX, event.clientY, nv.primaryDragMode]));
  }
  const touch = (type, pointerId, clientX, clientY) => canvas.dispatchEvent(new FakePointerEvent(type, { pointerType: 'touch', pointerId, clientX, clientY }));
  return { canvas, nv, seen, touch, release };
}

test('a single finger reaches NiiVue unchanged', () => {
  const { seen, touch, nv } = setup();
  touch('pointerdown', 1, 10, 10);
  touch('pointermove', 1, 20, 20);
  touch('pointerup', 1, 20, 20);
  assert.deepEqual(seen.map(([type, pointerType]) => [type, pointerType]), [['pointerdown', 'touch'], ['pointermove', 'touch'], ['pointerup', 'touch']]);
  assert.deepEqual(nv.pan2Dxyzmm, [1, 2, 3, 1]);
});

test('mouse and pen events are never intercepted', () => {
  const { canvas, seen } = setup();
  canvas.dispatchEvent(new FakePointerEvent('pointerdown', { pointerType: 'mouse', pointerId: 1, clientX: 5, clientY: 5 }));
  canvas.dispatchEvent(new FakePointerEvent('pointerdown', { pointerType: 'pen', pointerId: 2, clientX: 6, clientY: 6 }));
  assert.equal(seen.length, 2);
});

test('pinching a slice zooms it and replays a pan drag at the midpoint', () => {
  const { seen, touch, nv } = setup();
  touch('pointerdown', 1, 100, 100);
  touch('pointerdown', 2, 200, 100);
  // NiiVue's crosshair drag is ended, then a pan drag starts between the fingers.
  assert.deepEqual(seen.slice(1), [
    ['pointerup', 'mouse', 100, 100, DRAG.crosshair],
    ['pointerdown', 'mouse', 150, 100, DRAG.pan],
  ]);

  touch('pointermove', 1, 50, 120);
  touch('pointermove', 2, 250, 120);
  assert.equal(nv.pan2Dxyzmm[3], 2, 'doubling the finger distance doubles the zoom');
  assert.deepEqual(nv.pan2Dxyzmm.slice(0, 3), [1, 2, 3], 'the adapter leaves the pan offset to NiiVue');
  assert.deepEqual(seen.at(-1), ['pointermove', 'mouse', 150, 120, DRAG.pan], 'the midpoint moved 20 px down');
  assert.equal(seen.some(([, pointerType], index) => index > 0 && pointerType === 'touch'), false, 'NiiVue never sees the second finger');

  touch('pointerup', 2, 250, 120);
  assert.deepEqual(seen.at(-1).slice(0, 2), ['pointerup', 'mouse']);
  assert.equal(nv.primaryDragMode, DRAG.crosshair, 'the drag mode the user chose is restored');

  // The finger still down must not drag the crosshair.
  const count = seen.length;
  touch('pointermove', 1, 10, 10);
  touch('pointerup', 1, 10, 10);
  assert.equal(seen.length, count);

  // A fresh single touch works normally again.
  touch('pointerdown', 3, 30, 30);
  assert.deepEqual(seen.at(-1).slice(0, 2), ['pointerdown', 'touch']);
});

test('zoom is clamped to the range NiiVue supports', () => {
  const { touch, nv } = setup();
  touch('pointerdown', 1, 100, 100);
  touch('pointerdown', 2, 101, 100);
  touch('pointermove', 2, 900, 100);
  assert.equal(nv.pan2Dxyzmm[3], 10);
  touch('pointermove', 2, 100.01, 100);
  assert.equal(nv.pan2Dxyzmm[3], 0.1);
});

test('pinching the 3D render changes its scale without a pan drag', () => {
  const { seen, touch, nv } = setup({ sliceType: RENDER, isRender: true });
  touch('pointerdown', 1, 100, 100);
  touch('pointerdown', 2, 200, 100);
  touch('pointermove', 2, 250, 100);
  assert.equal(nv.scaleMultiplier, 1.5);
  assert.deepEqual(nv.pan2Dxyzmm, [1, 2, 3, 1], '2D zoom is untouched');
  assert.equal(nv.primaryDragMode, DRAG.crosshair);
  assert.deepEqual(seen.map(([type, pointerType]) => [type, pointerType]), [['pointerdown', 'touch'], ['pointerup', 'mouse']]);
  touch('pointermove', 2, 900, 100);
  assert.equal(nv.scaleMultiplier, 2, 'clamped to the 3D range');
  touch('pointerup', 1, 100, 100);
  assert.equal(seen.length, 2, 'no pan drag to release');
});

test('the render tile is recognised from the layout when no tile was hit', () => {
  const { touch, nv } = setup({ sliceType: RENDER });
  nv.activeTileHit = null;
  touch('pointerdown', 1, 100, 100);
  touch('pointerdown', 2, 200, 100);
  touch('pointermove', 2, 150, 100);
  assert.equal(nv.scaleMultiplier, 0.5);
});

test('while drawing, a pinch zooms but does not replay a drag that would paint', () => {
  const { seen, touch, nv } = setup({ drawIsEnabled: true });
  touch('pointerdown', 1, 100, 100);
  touch('pointerdown', 2, 200, 100);
  touch('pointermove', 2, 300, 100);
  assert.equal(nv.pan2Dxyzmm[3], 2);
  assert.equal(nv.primaryDragMode, DRAG.crosshair);
  assert.equal(seen.filter(([type, pointerType]) => type === 'pointerdown' && pointerType === 'mouse').length, 0);
});

test('lifting and replacing a finger continues with a new gesture', () => {
  const { touch, nv } = setup();
  touch('pointerdown', 1, 100, 100);
  touch('pointerdown', 2, 200, 100);
  touch('pointermove', 2, 300, 100);
  touch('pointerup', 2, 300, 100);
  touch('pointerdown', 3, 200, 100);
  touch('pointermove', 3, 300, 100);
  assert.equal(nv.pan2Dxyzmm[3], 4, 'the second pinch starts from the zoom the first one left');
  assert.equal(nv.primaryDragMode, DRAG.pan);
  touch('pointercancel', 3, 300, 100);
  assert.equal(nv.primaryDragMode, DRAG.crosshair, 'a cancelled touch also restores the drag mode');
});

test('release removes the listeners', () => {
  const { seen, touch, release } = setup();
  release();
  touch('pointerdown', 1, 100, 100);
  touch('pointerdown', 2, 200, 100);
  assert.equal(seen.length, 2, 'both fingers reach NiiVue once the adapter is gone');
});
