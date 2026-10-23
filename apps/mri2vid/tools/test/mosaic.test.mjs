// Siemens mosaic reader: de-tiling and the 4D reductions.
//
// A mosaic file packs a whole volume into one square frame, so a run of files is
// 4D. The reader must recover the tiles in spatial slice order, collapse the run
// with the chosen reduction, and never hold more than one volume's worth of
// samples. The goldens come from tools/gen_phantom.py, which builds the mosaic
// from a formula (zero subject data).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { convertDicom } from '@neurodesk/mri2vid/node';
import { readDicomSeries, readDicomHeader, mosaicInfo, parseDicom } from '@neurodesk/mri2vid/readers/dicom.js';
import { groupSeries } from '@neurodesk/mri2vid/series.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const PHANTOM = path.join(ROOT, 'tools', 'phantom_out');
const GOLDEN = path.join(ROOT, 'tools', 'golden');
const MOSAIC_DIR = path.join(PHANTOM, 'dicom_mosaic');

function readAB(p) {
  const buf = fs.readFileSync(p);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

function mosaicFiles() {
  return fs.readdirSync(MOSAIC_DIR)
    .filter((n) => n.endsWith('.dcm'))
    .sort()
    .map((n) => ({ name: n, buffer: readAB(path.join(MOSAIC_DIR, n)) }));
}

function goldenFloat(name) {
  return new Float32Array(readAB(path.join(GOLDEN, `${name}.bin`)));
}

function assertClose(actual, golden, label, tol = 1e-4) {
  assert.equal(actual.length, golden.length, `${label}: length mismatch`);
  let maxDiff = 0, at = -1;
  for (let i = 0; i < golden.length; i++) {
    const d = Math.abs(actual[i] - golden[i]);
    if (d > maxDiff) { maxDiff = d; at = i; }
  }
  assert.ok(maxDiff <= tol, `${label}: max|diff| = ${maxDiff} at ${at} (got ${actual[at]}, want ${golden[at]})`);
}

const have = fs.existsSync(MOSAIC_DIR) && fs.existsSync(path.join(GOLDEN, 'readers.json'));

test('mosaic phantom present', () => {
  assert.ok(have, 'Run tools/gen_phantom.py first');
});

if (have) {
  const meta = JSON.parse(fs.readFileSync(path.join(GOLDEN, 'readers.json'), 'utf8')).dicom_mosaic;
  const { slices: NS, volumes: NV, tile: TILE } = meta;

  test('detects a mosaic and its grid', () => {
    const files = mosaicFiles();
    const { map } = parseDicom(files[0].buffer, { headerOnly: true });
    const info = mosaicInfo(map);
    assert.ok(info, 'mosaic not detected');
    assert.equal(info.n, NS);
    assert.equal(info.tileH, TILE);
    assert.equal(info.tileW, TILE);
    // ceil(sqrt(5)) = 3, so the frame is 3 tiles across.
    assert.equal(info.grid, Math.ceil(Math.sqrt(NS)));
    assert.equal(info.rows, info.grid * TILE);
  });

  test('a non-mosaic series is not detected as one', () => {
    const dir = path.join(PHANTOM, 'dicom_single');
    const name = fs.readdirSync(dir).filter((n) => n.endsWith('.dcm')).sort()[0];
    const { map } = parseDicom(readAB(path.join(dir, name)), { headerOnly: true });
    assert.equal(mosaicInfo(map), null);
  });

  test('header reports the mosaic slice count', () => {
    const files = mosaicFiles();
    const h = readDicomHeader(files[0].buffer, files[0].name);
    assert.equal(h.mosaicSlices, NS);
  });

  test('first volume: de-tiles into slices in spatial order', async () => {
    const vol = await readDicomSeries(mosaicFiles(), { convertDicom, mosaicReduce: 'first' });
    assert.deepEqual(vol.dims, [TILE, TILE, NS]);
    assert.equal(vol.channels, 1);
    assertClose(vol.data, goldenFloat('reader_mosaic_first'), 'mosaic first');
  });

  test('mean reduction averages across all volumes', async () => {
    const vol = await readDicomSeries(mosaicFiles(), { convertDicom, mosaicReduce: 'mean' });
    assert.deepEqual(vol.dims, [TILE, TILE, NS]);
    assertClose(vol.data, goldenFloat('reader_mosaic_mean'), 'mosaic mean');
  });

  test('max reduction takes the maximum across all volumes', async () => {
    const vol = await readDicomSeries(mosaicFiles(), { convertDicom, mosaicReduce: 'max' });
    assert.deepEqual(vol.dims, [TILE, TILE, NS]);
    assertClose(vol.data, goldenFloat('reader_mosaic_max'), 'mosaic max');
  });

  test('reduction only changes with more than one volume', async () => {
    const one = mosaicFiles().slice(0, 1);
    const first = await readDicomSeries(one, { convertDicom, mosaicReduce: 'first' });
    const mean = await readDicomSeries(one, { convertDicom, mosaicReduce: 'mean' });
    const max = await readDicomSeries(one, { convertDicom, mosaicReduce: 'max' });
    assertClose(mean.data, first.data, 'single-volume mean', 0);
    assertClose(max.data, first.data, 'single-volume max', 0);
  });

  test('an unknown reduction falls back to the first volume', async () => {
    const vol = await readDicomSeries(mosaicFiles(), { convertDicom, mosaicReduce: 'not-a-mode' });
    assertClose(vol.data, goldenFloat('reader_mosaic_first'), 'mosaic fallback');
  });

  test('default reduction is the first volume', async () => {
    const vol = await readDicomSeries(mosaicFiles(), { convertDicom });
    assertClose(vol.data, goldenFloat('reader_mosaic_first'), 'mosaic default');
  });

  test('the first volume converts only the first file of the run', async () => {
    const converted = [];
    const counting = (inputs) => { converted.push(inputs.length); return convertDicom(inputs); };
    const vol = await readDicomSeries(mosaicFiles(), { convertDicom: counting, mosaicReduce: 'first' });
    assert.deepEqual(converted, [1]);
    assert.equal(vol.meta.volumes, NV);
    assert.match(vol.meta.note, /using the first volume/);
  });

  test('a run converted one file at a time reduces exactly as it does in one call', async () => {
    for (const reduce of ['mean', 'max']) {
      const converted = [];
      const counting = (inputs) => { converted.push(inputs.length); return convertDicom(inputs); };
      const whole = await readDicomSeries(mosaicFiles(), { convertDicom, mosaicReduce: reduce });
      const vol = await readDicomSeries(mosaicFiles(), { convertDicom: counting, mosaicReduce: reduce, batchBytes: 1 });
      assert.deepEqual(converted, Array(NV).fill(1));
      assert.deepEqual(vol.data, whole.data, `batched mosaic ${reduce}`);
      assert.equal(vol.meta.used, NV);
    }
  });

  // Copies of the run with one DS element rewritten in place, keeping its length.
  function rewritten(element, value, suffix) {
    return mosaicFiles().map(({ name, buffer }) => {
      const bytes = new Uint8Array(buffer.slice(0));
      const at = Buffer.from(bytes.buffer).indexOf(Buffer.from([0x18, 0, element, 0, 0x44, 0x53]));
      assert.ok(at > 0, `(0018,${element.toString(16)}) not found`);
      const length = bytes[at + 6] | (bytes[at + 7] << 8);
      bytes.set(Buffer.from(value.padEnd(length, ' ')), at + 8);
      return { name: name.replace('.dcm', `${suffix}.dcm`), buffer: bytes.buffer };
    });
  }

  const otherAcquisitions = [['echo time', 0x81, '44'], ['repetition time', 0x80, '9']];
  for (const [label, element, value] of otherAcquisitions) {
    test(`files with another ${label} are left out of the run, not averaged in`, async () => {
      const secondEcho = rewritten(element, value, '_e2');
      for (const reduce of ['mean', 'max']) {
        const names = [];
        const recording = (inputs) => { names.push(...inputs.map((f) => f.name)); return convertDicom(inputs); };
        const vol = await readDicomSeries([...mosaicFiles(), ...secondEcho], { convertDicom: recording, mosaicReduce: reduce, batchBytes: 1 });
        assert.ok(names.every((n) => !n.includes('_e2')), `${reduce}: a second-echo file was converted`);
        assertClose(vol.data, goldenFloat(`reader_mosaic_${reduce}`), `two-echo mosaic ${reduce}`);
        assert.match(vol.meta.note, new RegExp(`${NV} file\\(s\\) of this series are not part of the first mosaic run`));
      }
    });
  }

  test('reports the reduction in meta and does not hold the whole 4D run', async () => {
    const vol = await readDicomSeries(mosaicFiles(), { convertDicom, mosaicReduce: 'mean' });
    assert.equal(vol.meta.slices, NS);
    assert.equal(vol.meta.volumes, NV);
    assert.equal(vol.meta.used, NV);
    assert.match(vol.meta.note, /mean across 3 of 3 volumes/);
    // One volume of samples, not NV of them.
    assert.equal(vol.data.length, TILE * TILE * NS);
  });

  test('grouping labels a mosaic run as a 4D EPI series, not a structural scan', () => {
    const files = mosaicFiles();
    const headers = files.map((f) => readDicomHeader(f.buffer, f.name));
    const { series } = groupSeries(headers);
    assert.equal(series.length, 1);
    const s = series[0];
    assert.equal(s.isMosaic, true);
    assert.equal(s.volumes, NV);
    // Slice count is per volume, not the file count.
    assert.equal(s.sliceCount, NS);
    assert.equal(s.classification.label, 'fmri');
  });
}
