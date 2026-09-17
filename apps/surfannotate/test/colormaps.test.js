import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EXTRA_COLORMAPS, ECCENTRICITY_RYGBP, ECCENTRICITY_RYBC, POLAR_ANGLE_YBGR,
  POLAR_ANGLE_RYGBP, POLAR_ANGLE_RYBC, mirrorPolarAngle, sampleControlPoints,
  colormapKey, baseColormap, isFlipped, canFlip, registerExtraColormaps, colormapWindow,
  colormapRole, cycleUnit
} from '../src/niivue/colormaps.js';

const TWO_PI = 2 * Math.PI;

const rgbAt = (cmap, i) => [cmap.R[i], cmap.G[i], cmap.B[i]];
const RED = [255, 0, 0];
const YELLOW = [255, 255, 0];
const GREEN = [0, 255, 0];
const BLUE = [0, 0, 255];
const CYAN = [0, 255, 255];


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

test('the evenly spaced polar-angle maps are cyclic', () => {
  // The property the whole window rule exists to protect: 0 and one full turn
  // are the same direction, so they must be the same colour.
  for (const [name, cmap] of [['YBGR', POLAR_ANGLE_YBGR], ['RYBC', POLAR_ANGLE_RYBC]]) {
    const last = cmap.I.length - 1;
    for (const channel of ['R', 'G', 'B']) {
      assert.equal(cmap[channel][0], cmap[channel][last],
        `${name}: ${channel} differs between the two ends`);
    }
  }
});

test('the YBGR polar-angle map runs yellow, blue, green, red at the quarter turns', () => {
  assert.deepEqual([0, 1, 2, 3].map((i) => rgbAt(POLAR_ANGLE_YBGR, i)),
    [YELLOW, BLUE, GREEN, RED]);
});

test('the RYBC polar-angle map runs red, yellow, blue, cyan at the quarter turns', () => {
  assert.deepEqual([0, 1, 2, 3].map((i) => rgbAt(POLAR_ANGLE_RYBC, i)),
    [RED, YELLOW, BLUE, CYAN]);
  assert.deepEqual(POLAR_ANGLE_RYBC.I, POLAR_ANGLE_YBGR.I, 'same quarter-turn spacing as YBGR');
});

test('the RYBC eccentricity map is the same sequence, ending on cyan rather than wrapping', () => {
  assert.deepEqual([0, 1, 2, 3].map((i) => rgbAt(ECCENTRICITY_RYBC, i)),
    [RED, YELLOW, BLUE, CYAN]);
  assert.equal(ECCENTRICITY_RYBC.I.length, 4, 'no wrap-around stop');
  assert.equal(colormapRole('RYBC_eccentricity'), 'eccentricity');
  assert.equal(colormapRole('RYBC_polar-angle'), 'polar_angle');
});

test('sampling a control-point map interpolates the way NiiVue does', () => {
  assert.deepEqual(sampleControlPoints(POLAR_ANGLE_YBGR, 0), [255, 255, 0, 255]);
  assert.deepEqual(sampleControlPoints(POLAR_ANGLE_YBGR, 64), [0, 0, 255, 255]);
  assert.deepEqual(sampleControlPoints(POLAR_ANGLE_YBGR, 32), [128, 128, 128, 255]);
  assert.deepEqual(sampleControlPoints(POLAR_ANGLE_YBGR, 255), [255, 255, 0, 255]);
});

const FLIPPED_PAIRS = [
  ['YBGR_polar-angle', 'YBGR_polar-angle-flipped'],
  ['RYGBP_polar-angle', 'RYGBP_polar-angle-flipped'],
  ['RYBC_polar-angle', 'RYBC_polar-angle-flipped']
];

test('a flipped polar-angle map is its original mirrored about the vertical meridian', () => {
  // The colour at θ on the flipped map is the colour at π − θ on the original,
  // to within LUT rounding, at every index except the seam between the
  // original's two ends (128 and 129), where a nearly cyclic map steps.
  for (const [key, flippedKey] of FLIPPED_PAIRS) {
    const original = EXTRA_COLORMAPS[key];
    const flipped = EXTRA_COLORMAPS[flippedKey];
    assert.equal(flipped.I[0], 0, `${flippedKey} does not start at 0`);
    assert.equal(flipped.I[flipped.I.length - 1], 255, `${flippedKey} does not end at 255`);
    for (let j = 0; j < 256; j++) {
      if (j === 128 || j === 129) continue;
      const mirror = (128 - j + 256) % 256;
      const got = sampleControlPoints(flipped, j);
      const want = sampleControlPoints(original, mirror);
      for (let c = 0; c < 4; c++) {
        assert.ok(Math.abs(got[c] - want[c]) <= 2,
          `${flippedKey}[${j}] = ${got}, expected ${key}[${mirror}] = ${want}`);
      }
    }
  }
});

test('flipping swaps the horizontal meridians and leaves the vertical ones alone', () => {
  // YBGR: east yellow, north blue, west green, south red. Seen from the other
  // hemisphere: east green, north blue, west yellow, south red.
  const rgb = (cmap, i) => sampleControlPoints(cmap, i).slice(0, 3);
  const POLAR_ANGLE_YBGR_FLIPPED = EXTRA_COLORMAPS['YBGR_polar-angle-flipped'];
  assert.deepEqual(rgb(POLAR_ANGLE_YBGR_FLIPPED, 0), GREEN, 'east');
  assert.deepEqual(rgb(POLAR_ANGLE_YBGR_FLIPPED, 64), BLUE, 'north');
  assert.deepEqual(rgb(POLAR_ANGLE_YBGR_FLIPPED, 128), YELLOW, 'west');
  const south = rgb(POLAR_ANGLE_YBGR_FLIPPED, 191);
  assert.ok(Math.abs(south[0] - 255) <= 2 && south[1] <= 10 && south[2] <= 2, `south ${south}`);
});

test('flipping never puts two stops on one index', () => {
  // NiiVue divides by the segment length, so a zero-length segment would paint
  // that LUT entry black.
  for (const [, flippedKey] of FLIPPED_PAIRS) {
    const { I } = EXTRA_COLORMAPS[flippedKey];
    for (let i = 1; i < I.length; i++) {
      assert.ok(I[i] > I[i - 1], `${flippedKey}.I repeats or reverses at ${i}`);
    }
  }
});

test('flipping twice gives the original back', () => {
  for (const [key] of FLIPPED_PAIRS) {
    const original = EXTRA_COLORMAPS[key];
    const twice = mirrorPolarAngle(mirrorPolarAngle(original));
    for (let j = 0; j < 256; j++) {
      if (j === 128 || j === 129) continue;
      const got = sampleControlPoints(twice, j);
      const want = sampleControlPoints(original, j);
      for (let c = 0; c < 4; c++) {
        assert.ok(Math.abs(got[c] - want[c]) <= 2, `${key} twice-flipped differs at ${j}`);
      }
    }
  }
});

test('the flipped maps are polar-angle maps too', () => {
  for (const [, flippedKey] of FLIPPED_PAIRS) {
    assert.equal(colormapRole(flippedKey), 'polar_angle', flippedKey);
  }
});

test('every polar-angle map, and nothing else, has a flipped twin registered', () => {
  for (const key of Object.keys(EXTRA_COLORMAPS)) {
    if (isFlipped(key)) continue;
    assert.equal(`${key}-flipped` in EXTRA_COLORMAPS, canFlip(key), key);
  }
});

test('the flip box composes the key and reads it back', () => {
  assert.equal(colormapKey('YBGR_polar-angle', false), 'YBGR_polar-angle');
  assert.equal(colormapKey('YBGR_polar-angle', true), 'YBGR_polar-angle-flipped');
  // A flip asked of a map that has no hemisphere to flip for is ignored, not
  // an error: the box keeps its state across a detour through eccentricity.
  assert.equal(colormapKey('RYBC_eccentricity', true), 'RYBC_eccentricity');
  assert.equal(colormapKey('gist_rainbow', true), 'gist_rainbow');

  assert.equal(baseColormap('YBGR_polar-angle-flipped'), 'YBGR_polar-angle');
  assert.equal(baseColormap('YBGR_polar-angle'), 'YBGR_polar-angle');
  assert.equal(isFlipped('YBGR_polar-angle-flipped'), true);
  assert.equal(isFlipped('YBGR_polar-angle'), false);

  assert.equal(canFlip('RYGBP_polar-angle'), true);
  assert.equal(canFlip('RYGBP_eccentricity'), false);
  assert.equal(canFlip('gist_rainbow'), false);
  assert.equal(canFlip('gray'), false);
});

test('the RYGBP polar-angle map is gist_rainbow under a polar-angle role', () => {
  // The same colours, deliberately: the point is to offer the convention many
  // figures already use, with the wheel and the full-turn window it needs.
  assert.equal(POLAR_ANGLE_RYGBP, EXTRA_COLORMAPS.gist_rainbow);
  assert.equal(colormapRole('RYGBP_polar-angle'), 'polar_angle');
  assert.equal(colormapRole('gist_rainbow'), null);
  // Red, yellow, green, blue in that order along the scale.
  const rgb = (i) => [POLAR_ANGLE_RYGBP.R[i], POLAR_ANGLE_RYGBP.G[i], POLAR_ANGLE_RYGBP.B[i]];
  assert.deepEqual(rgb(1), [255, 0, 0]);
  assert.deepEqual(rgb(2), [255, 255, 0]);
  assert.deepEqual(rgb(3), [0, 255, 0]);
  assert.deepEqual(rgb(5), [0, 0, 255]);
});

test('every colour map name spells out its role', () => {
  assert.equal(colormapRole('RYGBP_eccentricity'), 'eccentricity');
  assert.equal(colormapRole('YBGR_polar-angle'), 'polar_angle');
  assert.equal(colormapRole('RYGBP_polar-angle'), 'polar_angle');
  assert.equal(colormapRole('RYBC_polar-angle'), 'polar_angle');
  assert.equal(colormapRole('RYBC_eccentricity'), 'eccentricity');
  for (const key of ['gray', 'viridis', 'gist_rainbow', 'eccentricity', 'polar_angle']) {
    assert.equal(colormapRole(key), null, `${key} should have no role`);
  }
});

test('the RYGBP eccentricity map runs red at the fovea to purple at the periphery', () => {
  const last = ECCENTRICITY_RYGBP.I.length - 1;
  assert.deepEqual(
    [ECCENTRICITY_RYGBP.R[0], ECCENTRICITY_RYGBP.G[0], ECCENTRICITY_RYGBP.B[0]], [255, 0, 0]
  );
  assert.deepEqual(
    [ECCENTRICITY_RYGBP.R[last], ECCENTRICITY_RYGBP.G[last], ECCENTRICITY_RYGBP.B[last]],
    [128, 0, 255]
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
      if (key === 'RYGBP_eccentricity') throw new Error('nope');
    }
  });
  assert.ok(!registered.includes('RYGBP_eccentricity'));
  assert.ok(registered.includes('YBGR_polar-angle'));
  assert.ok(registered.includes('RYGBP_polar-angle'));
  assert.ok(registered.includes('RYBC_polar-angle'));
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
  const window = colormapWindow('RYGBP_eccentricity', values, { low: 0.5, high: 8 });
  assert.equal(window.low, 0);
  assert.equal(window.high, 8);
  assert.match(window.note, /fovea/);
});

test('every eccentricity map gets the same window', () => {
  const values = Float32Array.from([0.1, 2, 4, 6, 8, 40]);
  const rygbp = colormapWindow('RYGBP_eccentricity', values, { low: 0.5, high: 8 });
  const rybc = colormapWindow('RYBC_eccentricity', values, { low: 0.5, high: 8 });
  assert.deepEqual([rybc.low, rybc.high], [rygbp.low, rygbp.high]);
});

test('eccentricity falls back to the data when there is no robust range', () => {
  const window = colormapWindow('RYGBP_eccentricity', Float32Array.from([0, 3, 7.5]), null);
  assert.deepEqual([window.low, window.high], [0, 7.5]);
});

test('polar angle in radians gets one full turn', () => {
  const values = Float32Array.from([0.01, 1.5, 3.1, 6.1]);
  const window = colormapWindow('YBGR_polar-angle', values, { low: 0.2, high: 6 });
  assert.equal(window.low, 0);
  assert.equal(window.high, TWO_PI);
  assert.match(window.note, /radians/);
});

test('polar angle in degrees gets one full turn', () => {
  const values = Float32Array.from([0, 90, 180, 355]);
  const window = colormapWindow('YBGR_polar-angle', values, { low: 5, high: 350 });
  assert.deepEqual([window.low, window.high], [0, 360]);
  assert.match(window.note, /degrees/);
});

test('every polar-angle map gets the same window', () => {
  const values = Float32Array.from([0.01, 1.5, 3.1, 6.1]);
  const ybgr = colormapWindow('YBGR_polar-angle', values, { low: 0.2, high: 6 });
  for (const key of ['RYGBP_polar-angle', 'RYBC_polar-angle', 'YBGR_polar-angle-flipped']) {
    const other = colormapWindow(key, values, { low: 0.2, high: 6 });
    assert.deepEqual([other.low, other.high, other.unit], [ybgr.low, ybgr.high, ybgr.unit], key);
  }
});

test('signed polar angle is the same turn centred on zero', () => {
  const radians = colormapWindow('YBGR_polar-angle', Float32Array.from([-3.1, 0, 3.1]), null);
  assert.deepEqual([radians.low, radians.high], [-Math.PI, Math.PI]);

  const degrees = colormapWindow('YBGR_polar-angle', Float32Array.from([-179, 0, 179]), null);
  assert.deepEqual([degrees.low, degrees.high], [-180, 180]);
});

test('a maximum a hair past the turn is still that turn', () => {
  // 2*pi printed to four decimals, which is what a file written by hand holds.
  const window = colormapWindow('YBGR_polar-angle', Float32Array.from([0, 6.2832]), null);
  assert.equal(window.high, TWO_PI);
});

test('the window names its own unit, so a legend need not re-derive it', () => {
  assert.equal(colormapWindow('YBGR_polar-angle', Float32Array.from([0, 6.1]), null).unit,
    'radians');
  assert.equal(colormapWindow('YBGR_polar-angle', Float32Array.from([0, 355]), null).unit,
    'degrees');
  assert.equal(colormapWindow('RYGBP_eccentricity', Float32Array.from([0, 8]), null).unit, null);
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
  assert.equal(colormapWindow('YBGR_polar-angle', Float32Array.from([0, 1000]), null), null);
  assert.equal(colormapWindow('YBGR_polar-angle', new Float32Array(0), null), null);
  assert.equal(colormapWindow('YBGR_polar-angle', Float32Array.from([NaN, NaN]), null), null);
});
