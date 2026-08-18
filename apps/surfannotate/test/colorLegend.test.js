import test from 'node:test';
import assert from 'node:assert/strict';

import {
  legendKind, legendTicks, paintLegend, rangeDecimals
} from '../src/niivue/colorLegend.js';

const TWO_PI = 2 * Math.PI;

// A LUT whose channels are its own index, so a painted pixel reports which
// entry it was sampled from. Asserting against the real colour maps would only
// restate the arithmetic under test.
const RAMP = new Uint8ClampedArray(256 * 4);
for (let i = 0; i < 256; i++) {
  RAMP[i * 4] = i;
  RAMP[i * 4 + 1] = i;
  RAMP[i * 4 + 2] = i;
  RAMP[i * 4 + 3] = 255;
}

// Odd, so the middle column and row pass exactly through the centre and the
// compass points can be sampled without a half-pixel of slop.
const SIZE = 65;
const MIDDLE = 32;

function pixel(pixels, column, row, width = SIZE) {
  const at = (row * width + column) * 4;
  return { index: pixels[at], alpha: pixels[at + 3] };
}

test('only the two retinotopy maps get a wheel', () => {
  assert.equal(legendKind('eccentricity'), 'eccentricity');
  assert.equal(legendKind('polar_angle'), 'polar_angle');
  for (const key of ['gray', 'viridis', 'gist_rainbow', 'hot', 'jet']) {
    assert.equal(legendKind(key), 'bar', `${key} should get a bar`);
  }
});

test('the polar-angle wheel runs counter-clockwise from the right', () => {
  // The property the whole wheel exists to get right. Dorsal V2 represents the
  // lower visual field and ventral V2 the upper; with polar angle measured the
  // standard way those land near 3*pi/2 and pi/2 respectively, so a mirrored
  // wheel would put a subject's V2d where a reader reads V2v. A sign slip in
  // the azimuth fails here rather than in a figure.
  const pixels = paintLegend('polar_angle', RAMP, SIZE);
  assert.equal(pixel(pixels, 60, MIDDLE).index, 0, 'east is the start of the cycle');
  assert.equal(pixel(pixels, MIDDLE, 5).index, 64, 'north is a quarter turn');
  assert.equal(pixel(pixels, 4, MIDDLE).index, 128, 'west is half a turn');
  assert.equal(pixel(pixels, MIDDLE, 60).index, 191, 'south is three quarters');
});

test('the eccentricity wheel is coloured by radius from the fovea out', () => {
  const pixels = paintLegend('eccentricity', RAMP, SIZE);
  assert.equal(pixel(pixels, MIDDLE, MIDDLE).index, 0, 'the centre is the fovea');

  // Same distance in every direction, so nothing angular has leaked in.
  const radius = SIZE / 2;
  const expected = Math.round((28 / radius) * 255);
  for (const [column, row] of [[60, MIDDLE], [MIDDLE, 4], [4, MIDDLE], [MIDDLE, 60]]) {
    assert.equal(pixel(pixels, column, row).index, expected);
  }
});

test('a wheel is transparent outside its disk', () => {
  for (const kind of ['eccentricity', 'polar_angle']) {
    const pixels = paintLegend(kind, RAMP, SIZE);
    assert.equal(pixel(pixels, 0, 0).alpha, 0, `${kind} painted its corner`);
    assert.equal(pixel(pixels, SIZE - 1, 0).alpha, 0, `${kind} painted its corner`);
    assert.equal(pixel(pixels, MIDDLE, MIDDLE).alpha, 255, `${kind} left a hole`);
  }
});

test('the bar ramps left to right and ignores its height', () => {
  const width = 256;
  const pixels = paintLegend('bar', RAMP, width, 4);
  for (const row of [0, 3]) {
    assert.equal(pixel(pixels, 0, row, width).index, 0);
    assert.equal(pixel(pixels, 128, row, width).index, 128);
    assert.equal(pixel(pixels, width - 1, row, width).index, 255);
    assert.equal(pixel(pixels, 200, row, width).alpha, 255);
  }
});

test('a bar is ticked at both ends and the middle', () => {
  assert.deepEqual(legendTicks('bar', 0, 1), [
    { label: '0', x: 0 },
    { label: '0.5', x: 0.5 },
    { label: '1', x: 1 }
  ]);
  assert.deepEqual(legendTicks('bar', -0.4, 0.6).map((tick) => tick.label),
    ['-0.4', '0.1', '0.6']);
});

test('polar-angle ticks name the quarter turns in the data\'s own unit', () => {
  assert.deepEqual(legendTicks('polar_angle', 0, TWO_PI).map((tick) => tick.label),
    ['0', 'π/2', 'π', '3π/2']);
  assert.deepEqual(legendTicks('polar_angle', 0, 360).map((tick) => tick.label),
    ['0°', '90°', '180°', '270°']);
  assert.deepEqual(legendTicks('polar_angle', -Math.PI, Math.PI).map((tick) => tick.label),
    ['−π', '−π/2', '0', 'π/2']);
});

test('a window that is no kind of turn is ticked as plain numbers', () => {
  // Whatever the user typed over the window with. Inventing a unit for it would
  // be worse than leaving the numbers bare.
  assert.deepEqual(legendTicks('polar_angle', 0, 5).map((tick) => tick.label),
    ['0', '1.25', '2.5', '3.75']);
});

test('polar-angle ticks sit at the compass points, y upward', () => {
  const [east, north, west, south] = legendTicks('polar_angle', 0, TWO_PI);
  assert.ok(east.x > 1 && Math.abs(east.y) < 1e-9, 'east');
  assert.ok(north.y > 1 && Math.abs(north.x) < 1e-9, 'north');
  assert.ok(west.x < -1 && Math.abs(west.y) < 1e-9, 'west');
  assert.ok(south.y < -1 && Math.abs(south.x) < 1e-9, 'south');
});

test('eccentricity ticks are the reference figure\'s three rings', () => {
  const ticks = legendTicks('eccentricity', 0, 7.7);
  assert.deepEqual(ticks.map((tick) => tick.label), ['2.567', '5.133', '7.7']);
  for (const tick of ticks) {
    assert.ok(tick.x > 0 && tick.y > 0, 'the labels go up the diagonal');
  }
  for (let i = 1; i < ticks.length; i++) {
    assert.ok(ticks[i].x > ticks[i - 1].x, 'the rings should step outward');
    assert.ok(ticks[i].y > ticks[i - 1].y, 'the rings should step outward');
  }
  // The outermost clears the disk, so the widest label is not on the colour.
  assert.ok(Math.hypot(ticks.at(-1).x, ticks.at(-1).y) > 1);
});

test('an empty or inverted window has nothing to tick', () => {
  for (const kind of ['bar', 'eccentricity', 'polar_angle']) {
    assert.deepEqual(legendTicks(kind, 1, 1), []);
    assert.deepEqual(legendTicks(kind, 1, 0), []);
    assert.deepEqual(legendTicks(kind, 0, NaN), []);
  }
});

test('the decimals suit the span, so a tick and its range box agree', () => {
  assert.equal(rangeDecimals(500), 1);
  assert.equal(rangeDecimals(7.7), 3);
  assert.equal(rangeDecimals(0.02), 5);
});
