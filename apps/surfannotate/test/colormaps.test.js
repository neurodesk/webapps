import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EXTRA_COLORMAPS, ECCENTRICITY, POLAR_ANGLE, registerExtraColormaps, colormapWindow,
  cycleUnit
} from '../src/niivue/colormaps.js';

const TWO_PI = 2 * Math.PI;

test('every extra colour map is a well-formed NiiVue control-point set', () => {
  for (const [key, cmap] of Object.entries(EXTRA_COLORMAPS)) {
    const length = cmap.I.length;
    for (const channel of ['R', 'G', 'B', 'A']) {
      assert.equal(cmap[channel].length, length, `${key}.${channel} is a different length`);
      for (const value of cmap[channel]) {
        assert.ok(value >= 0 && value <= 255, `${key}.${channel} has ${value} outside 0..255`);
      }
    }
    // NiiVue interpolates along I, so an unsorted or short scale silently
    // renders part of the data in the wrong colour rather than failing.
    assert.equal(cmap.I[0], 0, `${key} does not start at 0`);
    assert.equal(cmap.I[length - 1], 255, `${key} does not end at 255`);
    for (let i = 1; i < length; i++) {
      assert.ok(cmap.I[i] > cmap.I[i - 1], `${key}.I is not ascending at ${i}`);
    }
  }
});

test('the polar-angle map is cyclic', () => {
  // The property the whole window rule exists to protect: 0 and one full turn
  // are the same direction, so they must be the same colour.
  const last = POLAR_ANGLE.I.length - 1;
  for (const channel of ['R', 'G', 'B']) {
    assert.equal(POLAR_ANGLE[channel][0], POLAR_ANGLE[channel][last],
      `${channel} differs between the two ends`);
  }
});

test('the eccentricity map runs red at the fovea to violet at the periphery', () => {
  const last = ECCENTRICITY.I.length - 1;
  assert.deepEqual(
    [ECCENTRICITY.R[0], ECCENTRICITY.G[0], ECCENTRICITY.B[0]], [255, 0, 0]
  );
  assert.deepEqual(
    [ECCENTRICITY.R[last], ECCENTRICITY.G[last], ECCENTRICITY.B[last]], [128, 0, 255]
  );
});

test('registering reports the keys it added', () => {
  const added = [];
  const registered = registerExtraColormaps({
    addColormap: (key, cmap) => added.push([key, cmap])
  });
  assert.deepEqual(registered, Object.keys(EXTRA_COLORMAPS));
  assert.equal(added.length, Object.keys(EXTRA_COLORMAPS).length);
});

test('one colour map NiiVue rejects does not cost the others', () => {
  const registered = registerExtraColormaps({
    addColormap: (key) => {
      if (key === 'eccentricity') throw new Error('nope');
    }
  });
  assert.ok(!registered.includes('eccentricity'));
  assert.ok(registered.includes('polar_angle'));
});

test('an ordinary colour map asks for no particular window', () => {
  const values = Float32Array.from([0, 0.5, 1]);
  assert.equal(colormapWindow('gray', values, { low: 0, high: 1 }), null);
  assert.equal(colormapWindow('gist_rainbow', values, { low: 0, high: 1 }), null);
  assert.equal(colormapWindow('viridis', values, { low: 0.2, high: 0.8 }), null);
});

test('eccentricity is anchored at zero and keeps the robust maximum', () => {
  // The data max is 40 — one stray vertex. The robust high is what the map
  // should span, or that outlier compresses every real value into the red end.
  const values = Float32Array.from([0.1, 2, 4, 6, 8, 40]);
  const window = colormapWindow('eccentricity', values, { low: 0.5, high: 8 });
  assert.equal(window.low, 0);
  assert.equal(window.high, 8);
  assert.match(window.note, /fovea/);
});

test('eccentricity falls back to the data when there is no robust range', () => {
  const window = colormapWindow('eccentricity', Float32Array.from([0, 3, 7.5]), null);
  assert.deepEqual([window.low, window.high], [0, 7.5]);
});

test('polar angle in radians gets one full turn', () => {
  const values = Float32Array.from([0.01, 1.5, 3.1, 6.1]);
  const window = colormapWindow('polar_angle', values, { low: 0.2, high: 6 });
  assert.equal(window.low, 0);
  assert.equal(window.high, TWO_PI);
  assert.match(window.note, /radians/);
});

test('polar angle in degrees gets one full turn', () => {
  const values = Float32Array.from([0, 90, 180, 355]);
  const window = colormapWindow('polar_angle', values, { low: 5, high: 350 });
  assert.deepEqual([window.low, window.high], [0, 360]);
  assert.match(window.note, /degrees/);
});

test('signed polar angle is the same turn centred on zero', () => {
  const radians = colormapWindow('polar_angle', Float32Array.from([-3.1, 0, 3.1]), null);
  assert.deepEqual([radians.low, radians.high], [-Math.PI, Math.PI]);

  const degrees = colormapWindow('polar_angle', Float32Array.from([-179, 0, 179]), null);
  assert.deepEqual([degrees.low, degrees.high], [-180, 180]);
});

test('a maximum a hair past the turn is still that turn', () => {
  // 2*pi printed to four decimals, which is what a file written by hand holds.
  const window = colormapWindow('polar_angle', Float32Array.from([0, 6.2832]), null);
  assert.equal(window.high, TWO_PI);
});

test('the window names its own unit, so a legend need not re-derive it', () => {
  assert.equal(colormapWindow('polar_angle', Float32Array.from([0, 6.1]), null).unit,
    'radians');
  assert.equal(colormapWindow('polar_angle', Float32Array.from([0, 355]), null).unit,
    'degrees');
  assert.equal(colormapWindow('eccentricity', Float32Array.from([0, 8]), null).unit, null);
});

test('a full turn is recognised by its span, a partial one is not', () => {
  // What separates a window that came from colormapWindow from one the user
  // typed: 0 – 5 is neither radians nor degrees of anything.
  assert.equal(cycleUnit(2 * Math.PI), 'radians');
  assert.equal(cycleUnit(6.28), 'radians');
  assert.equal(cycleUnit(360), 'degrees');
  assert.equal(cycleUnit(5), null);
  assert.equal(cycleUnit(180), null);
  assert.equal(cycleUnit(NaN), null);
});

test('polar angle over values that fit no convention leaves the window alone', () => {
  // Better an unhelpful window than a turn invented for data that has none.
  assert.equal(colormapWindow('polar_angle', Float32Array.from([0, 1000]), null), null);
  assert.equal(colormapWindow('polar_angle', new Float32Array(0), null), null);
  assert.equal(colormapWindow('polar_angle', Float32Array.from([NaN, NaN]), null), null);
});
