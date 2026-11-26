import assert from 'node:assert/strict';
import test from 'node:test';
import { encode as encodePng } from 'fast-png';
import {
  BRIGHTFIELD_PIXEL_CLASSIFIER,
  DEFAULTS,
  MODEL_PIXEL_SIZE,
  chopIndices,
  clampAndPadReflect16,
  decodeInstanSeg,
  peakLocalMax,
  percentileNormalize,
  rescaleChwBilinear,
  rescaleLabelsNearest,
  segmentBrightfieldNuclei,
  stitchTiles,
} from '../src/pipeline.js';
import {
  compareInstanceLabels,
  labelOutlines,
  measureNuclei,
  nucleiCsv,
} from '../src/results.js';
import {
  readBrightfieldImage,
  stemName,
  writeLabelsTiff,
} from '../src/image-io.js';

test('percentileNormalize scales each channel independently by 0.1-99.9 percentiles', () => {
  const w = 10;
  const h = 10;
  const n = w * h;
  const chw = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    chw[i] = i * 2;
    chw[n + i] = 100 + i;
    chw[2 * n + i] = 50; // constant channel -> denominator clamps to epsilon=1e-3
  }
  const norm = percentileNormalize(chw, w, h, 0.1, 1e-3);
  assert.ok(norm[0] <= 0 && norm[n - 1] >= 1);
  assert.ok(Math.abs(norm[n + 50] - 0.5) < 0.02);
  for (let i = 0; i < n; i++) assert.equal(norm[2 * n + i], 0);
});

test('clampAndPadReflect16 clamps to [-2, 3] and reflect-pads to multiples of 16', () => {
  const w = 18;
  const h = 17;
  const chw = new Float32Array(3 * w * h);
  chw[0] = -10;
  chw[1] = 10;
  chw[w - 2] = 0.75;
  const padded = clampAndPadReflect16(chw, w, h, 3);
  assert.equal(padded.width, 32);
  assert.equal(padded.height, 32);
  assert.equal(padded.padW, 14);
  assert.equal(padded.padH, 15);
  assert.equal(padded.data[0], -2);
  assert.equal(padded.data[1], 3);
  // PyTorch reflect pad mirrors without repeating edge: index w mirrors w-2.
  assert.equal(padded.data[w], 0.75);
});

test('rescaleChwBilinear and rescaleLabelsNearest preserve scale and skip within 1% tolerance', () => {
  const chw = new Float32Array(3 * 32 * 32).fill(1);
  const unchanged = rescaleChwBilinear(chw, 32, 32, 0.502, MODEL_PIXEL_SIZE);
  assert.equal(unchanged.rescaled, false);
  const doubled = rescaleChwBilinear(chw, 32, 32, 1.0, MODEL_PIXEL_SIZE);
  assert.equal(doubled.rescaled, true);
  assert.equal(doubled.width, 64);
  assert.equal(doubled.height, 64);
  assert.ok(Math.abs(doubled.data[0] - 1) < 1e-6);

  const labels = new Int32Array(64 * 64);
  labels[10 * 64 + 10] = 7;
  labels[10 * 64 + 11] = 7;
  labels[11 * 64 + 10] = 7;
  labels[11 * 64 + 11] = 7;
  const back = rescaleLabelsNearest(labels, 64, 64, 32, 32);
  assert.equal(back.length, 32 * 32);
  assert.equal(back[5 * 32 + 5], 7);
});

test('rescaleChwBilinear matches PyTorch F.interpolate(scale_factor) on non-integer ratio and caps 16 MP', () => {
  // Reference from PyTorch F.interpolate(arange(29*27).reshape(1,1,29,27), scale_factor=0.33/0.5, mode="bilinear", align_corners=False)
  const w = 27;
  const h = 29;
  const ramp = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) ramp[i] = i;
  const res = rescaleChwBilinear(ramp, w, h, 0.33, MODEL_PIXEL_SIZE);
  assert.equal(res.rescaled, true);
  assert.equal(res.height, 19);
  assert.equal(res.width, 17);
  const expected = [
    [0, 0, 7.2121205],
    [0, 16, 31.4545460],
    [18, 0, 743.5757446],
    [9, 8, 387.5151367],
    [18, 16, 767.8181763],
  ];
  for (const [y, x, ref] of expected) {
    assert.ok(Math.abs(res.data[y * res.width + x] - ref) < 1e-4, `mismatch at (${y},${x}): ${res.data[y * res.width + x]} vs ${ref}`);
  }
  assert.throws(
    () => rescaleChwBilinear(new Float32Array(3), 4096, 4096, 2.0, MODEL_PIXEL_SIZE),
    /exceeding the 16 MP browser limit/,
  );
});

test('peakLocalMax matches PyTorch first-row-major tie breaking and threshold', () => {
  const w = 20;
  const h = 20;
  const map = new Float32Array(w * h);
  map[5 * w + 5] = 0.9;
  map[5 * w + 6] = 0.9; // tie within distance 5 -> (5, 5) wins
  map[14 * w + 14] = 0.85;
  map[14 * w + 2] = 0.65; // below 0.7 threshold
  const peaks = peakLocalMax(map, w, h, 5, 0.7);
  assert.deepEqual(peaks, [[5, 5], [14, 14]]);
});

test('decodeInstanSeg segments two separated nuclei and merges overlapping duplicate seeds', () => {
  const w = 64;
  const h = 64;
  const plane = w * h;
  const features = new Float32Array(5 * plane);
  // Place two distinct circular objects at (16, 16) and (48, 48) with strong sigma/seediness.
  const centres = [[16, 16], [48, 48]];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      let minDist = Infinity;
      let dx = 0;
      let dy = 0;
      for (const [cy, cx] of centres) {
        const d = Math.hypot(x - cx, y - cy);
        if (d < minDist) {
          minDist = d;
          dx = (cx - x) * 0.25;
          dy = (cy - y) * 0.25;
        }
      }
      // Inverse of (sigmoid(ch) - 0.5) * 8 = delta
      const sdx = Math.max(0.01, Math.min(0.99, dx / 8 + 0.5));
      const sdy = Math.max(0.01, Math.min(0.99, dy / 8 + 0.5));
      features[idx] = Math.log(sdx / (1 - sdx));
      features[plane + idx] = Math.log(sdy / (1 - sdy));
      // Inside radius 6: high confidence sigma/seediness matching brightfield classifier
      const inside = minDist <= 5;
      features[2 * plane + idx] = inside ? 1.5 : -2.0;
      features[3 * plane + idx] = inside ? 1.5 : -2.0;
      features[4 * plane + idx] = inside ? (1.0 - minDist * 0.05 - 0.5) * 15 : -10;
    }
  }
  const labels = decodeInstanSeg(features, w, h, w, h, { classifier: BRIGHTFIELD_PIXEL_CLASSIFIER });
  const rows = measureNuclei(labels, w, h, 0.5);
  assert.equal(rows.length, 2);
  assert.ok(rows[0].areaPx > 20 && rows[1].areaPx > 20);
  assert.ok(Math.abs(rows[0].areaUm2 - rows[0].areaPx * 0.25) < 1e-6);

  const outlines = labelOutlines(labels, w, h);
  let outlineCount = 0;
  for (let i = 0; i < outlines.length; i++) if (outlines[i] > 0) outlineCount++;
  assert.ok(outlineCount > 0 && outlineCount < rows[0].areaPx + rows[1].areaPx);

  const csv = nucleiCsv(rows);
  assert.match(csv, /^id,centroid_x_px,centroid_y_px,area_px,area_um2,equiv_diameter_um,bbox_x,bbox_y,bbox_w,bbox_h/);
});

test('decodeInstanSeg fills an interior hole using float32 maskThreshold precision', () => {
  const w = 64;
  const h = 64;
  const plane = w * h;
  const features = new Float32Array(5 * plane);
  // Ring nucleus centred at (32, 32): high confidence on radius [2, 6] plus seed at centre,
  // with an interior ring hole at radius 1.5..2.5 below threshold.
  const cx = 32;
  const cy = 32;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      const d = Math.hypot(x - cx, y - cy);
      const sdx = Math.max(0.01, Math.min(0.99, ((cx - x) * 0.25) / 8 + 0.5));
      const sdy = Math.max(0.01, Math.min(0.99, ((cy - y) * 0.25) / 8 + 0.5));
      features[idx] = Math.log(sdx / (1 - sdx));
      features[plane + idx] = Math.log(sdy / (1 - sdy));
      // Punch a 1-pixel hole at (32, 34) completely surrounded by foreground (radius <= 6)
      const isHole = x === 34 && y === 32;
      const inside = d <= 6 && !isHole;
      features[2 * plane + idx] = inside ? 1.5 : -2.0;
      features[3 * plane + idx] = inside ? 1.5 : -2.0;
      features[4 * plane + idx] = d === 0 ? 7.5 : inside ? 3.0 : -10;
    }
  }
  const labels = decodeInstanSeg(features, w, h, w, h, { classifier: BRIGHTFIELD_PIXEL_CLASSIFIER });
  assert.equal(labels[32 * w + 32], 1);
  assert.equal(labels[32 * w + 34], 1, 'interior hole pixel must be filled at float32 maskThreshold');
});

test('chopIndices and stitchTiles reconcile a nucleus crossing the tile seam', () => {
  const h = 700;
  const w = 700;
  const chops = chopIndices(h, w, 512, 512, 200);
  assert.deepEqual(chops.yStarts, [0, 188]);
  assert.deepEqual(chops.xStarts, [0, 188]);

  // Draw one shared nucleus centred at (350, 350) (inside overlap zone) and one per corner.
  const makeTile = (y0, x0, seedOffset) => {
    const t = new Int32Array(512 * 512);
    const drawDisc = (gy, gx, r, id) => {
      for (let y = 0; y < 512; y++) {
        for (let x = 0; x < 512; x++) {
          if (Math.hypot(y0 + y - gy, x0 + x - gx) <= r) t[y * 512 + x] = id;
        }
      }
    };
    drawDisc(350, 350, 14, seedOffset + 1); // seam-crossing nucleus present in all 4 tiles
    drawDisc(60, 60, 10, seedOffset + 2);
    drawDisc(640, 640, 10, seedOffset + 3);
    return t;
  };
  const tiles = [
    makeTile(0, 0, 10),
    makeTile(0, 188, 20),
    makeTile(188, 0, 30),
    makeTile(188, 188, 40),
  ];
  const stitched = stitchTiles(tiles, chops, h, w, 80);
  const rows = measureNuclei(stitched, w, h);
  assert.equal(rows.length, 3);
  const cmp = compareInstanceLabels(stitched, stitched);
  assert.equal(cmp.f1At90, 1);
  assert.equal(cmp.foregroundDice, 1);
});

test('readBrightfieldImage reads RGB PNG, rejects greyscale PNG, and writes calibrated label TIFF', async () => {
  const w = 32;
  const h = 24;
  const rgb = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    rgb[3 * i] = 200;
    rgb[3 * i + 1] = 120;
    rgb[3 * i + 2] = 180;
  }
  const pngBytes = encodePng({ width: w, height: h, data: rgb, channels: 3, depth: 8 });
  const img = await readBrightfieldImage('histology.png', pngBytes.buffer.slice(pngBytes.byteOffset, pngBytes.byteOffset + pngBytes.byteLength));
  assert.equal(img.width, w);
  assert.equal(img.height, h);
  assert.equal(img.format, 'PNG');
  assert.equal(img.rgbChw.length, 3 * w * h);
  assert.equal(stemName('sample.ome.tif'), 'sample');

  const gray = encodePng({ width: w, height: h, data: new Uint8Array(w * h), channels: 1, depth: 8 });
  await assert.rejects(
    readBrightfieldImage('gray.png', gray.buffer.slice(gray.byteOffset, gray.byteOffset + gray.byteLength)),
    /requires a 2D RGB brightfield image/,
  );

  const labels = new Int32Array(w * h);
  labels[5 * w + 5] = 1;
  const tiffBuf = writeLabelsTiff(labels, w, h, 0.5);
  assert.ok(tiffBuf.byteLength > 100);
});

test('segmentBrightfieldNuclei validates thresholds and integrates end to end with mock FCN', async () => {
  const w = 64;
  const h = 64;
  const rgbChw = new Float32Array(3 * w * h);
  for (let i = 0; i < w * h; i++) {
    rgbChw[i] = i % 255;
    rgbChw[w * h + i] = (i * 2) % 255;
    rgbChw[2 * w * h + i] = (i * 3) % 255;
  }
  await assert.rejects(
    segmentBrightfieldNuclei({ rgbChw, width: w, height: h, maskThreshold: 1.2, runFcn: async () => new Float32Array(1) }),
    /Mask threshold/,
  );
  const res = await segmentBrightfieldNuclei({
    rgbChw,
    width: w,
    height: h,
    pixelSize: 0.5,
    ...DEFAULTS,
    runFcn: async (_pad, ph, pw) => {
      const f = new Float32Array(5 * ph * pw);
      f[0] = 0.01;
      for (let i = 0; i < ph * pw; i++) f[4 * ph * pw + i] = -10; // zero seeds -> empty mask
      return f;
    },
  });
  assert.equal(res.tiles, 1);
  assert.equal(res.labels.length, w * h);
});
