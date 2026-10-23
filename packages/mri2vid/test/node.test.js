import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { dicomSeries } from '../../../test-utils/dicom-fixture.mjs';
import { syntheticNifti } from '../../../test-utils/nifti-fixture.mjs';
import { decodeVideo, inspectVideo } from '../src/inspect.js';
import { OPTIONS, convertDicom, encode, optionName, parseOptions } from '../src/node.js';
import { defaultNorm, renderFrame } from '../src/pipeline.js';
import { drawLabel, labelPlacement, rasterize, rgbToI420, sliceLabel } from '../src/raster.js';
import { readDicomSeries } from '../src/readers/dicom.js';
import { readNifti } from '../src/readers/nifti.js';
import { discoverSources, loadSource } from '../src/sources.js';

const bin = fileURLToPath(new URL('../bin/mri2vid.js', import.meta.url));
const automation = JSON.parse(await readFile(new URL('../../../apps/mri2vid/automation.json', import.meta.url), 'utf8'));

async function scratch(t) {
  const directory = await mkdtemp(join(tmpdir(), 'mri2vid-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function psnr(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] - b[i]) ** 2;
  return sum ? 10 * Math.log10((255 * 255 * a.length) / sum) : Infinity;
}

test('the options are the web app automation parameters, with the same defaults and ranges', () => {
  for (const operation of ['encode-volume', 'encode-dicom']) {
    for (const [key, parameter] of Object.entries(automation.operations[operation].parameters)) {
      const option = OPTIONS[key];
      assert.ok(option, `--${optionName(key)} is missing`);
      assert.equal(option.type, parameter.type, key);
      assert.equal(option.default, parameter.default, key);
      assert.equal(option.minimum, parameter.minimum, key);
      assert.equal(option.maximum, parameter.maximum, key);
      for (const value of parameter.enum ?? []) assert.ok(option.enum.includes(value), `${key} accepts ${value}`);
    }
  }
});

test('options are checked and their defaults filled in', () => {
  assert.deepEqual(parseOptions({}), {
    orientation: 'sagittal', fps: 20, step: 1, annotate: false, format: 'webm',
    colorNormalize: false, upscale: 1, interpolation: 'bilinear', mosaicReduce: 'first',
  });
  assert.equal(parseOptions({ fps: '12.5', annotate: true }).fps, 12.5);
  assert.throws(() => parseOptions({ fps: '0' }), /--fps must be at least 1/);
  assert.throws(() => parseOptions({ step: '1.5' }), /--step must be a whole number/);
  assert.throws(() => parseOptions({ orientation: 'oblique' }), /--orientation must be one of/);
  assert.throws(() => parseOptions({ upscale: 'two' }), /--upscale must be a number/);
});

test('frames become full-range BT.709 I420, as Chromium converts canvas frames', () => {
  const rgb = new Uint8Array([0, 0, 0, 128, 128, 128, 255, 255, 255, 255, 0, 0]);
  const yuv = rgbToI420(rasterize(rgb, 4, 1, 3, 4, 2), 4, 2);
  assert.deepEqual([...yuv.subarray(0, 4)], [0, 128, 255, 54]);
  assert.deepEqual([...yuv.subarray(4, 8)], [0, 0, 0, 0], 'the padding row is black');
  const gray = rgbToI420(rasterize(new Uint8ClampedArray([7, 7, 200, 200]), 2, 2, 1, 2, 2), 2, 2);
  assert.deepEqual([...gray], [7, 7, 200, 200, 128, 128]);
});

test('the slice label sits on the app baseline, 10 pixels in and up', () => {
  const [width, height] = [160, 166];
  const rgb = new Uint8Array(width * height * 3);
  drawLabel(rgb, width, height, sliceLabel(80, 210), height);
  const lit = [];
  for (let i = 0; i < width * height; i++) if (rgb[i * 3]) lit.push([i % width, Math.floor(i / width)]);
  const { baseline } = labelPlacement(height);
  assert.ok(lit.length > 50);
  assert.equal(Math.min(...lit.map(([x]) => x)), 10);
  assert.equal(Math.max(...lit.map(([, y]) => y)), baseline - 1);
  assert.equal(sliceLabel(80, 210), 'Slice 81/210');
});

test('a NIfTI volume encodes to VP9 in MP4 with the app timing and the rendered frames', async (t) => {
  const directory = await scratch(t);
  const dims = [24, 20, 10];
  const input = join(directory, 'phantom.nii.gz');
  await writeFile(input, syntheticNifti({ dims, value: (i) => (i * 7) % 251 + Math.floor(i / 480) * 10 }));
  const result = await encode({ inputs: [input], output: join(directory, 'out'), parameters: { orientation: 'axial', fps: '5', format: 'mp4', step: '2' } });
  assert.equal(result.output, join(directory, 'out', 'phantom_axial.mp4'));
  assert.deepEqual(result.sliceIndices, [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22]);
  const bytes = await readFile(result.output);
  const facts = await inspectVideo(bytes);
  assert.deepEqual(
    { container: facts.container, codec: facts.codec, width: facts.width, height: facts.height, frames: facts.frames },
    { container: 'mp4', codec: 'vp9', width: 10, height: 20, frames: 12 },
  );
  assert.deepEqual(facts.timestampsUs, Array.from({ length: 12 }, (_, i) => i * 200000));
  assert.deepEqual(facts.keyFrames, [0, 5, 10]);
  const vol = await readNifti(new Uint8Array(await readFile(input)).buffer, 'phantom.nii.gz');
  const decoded = await decodeVideo(bytes);
  decoded.forEach((frame, k) => {
    const source = renderFrame(vol, 'axial', result.sliceIndices[k], defaultNorm(vol), {});
    assert.ok(psnr(frame.y, source.frame) > 30, `frame ${k}`);
  });
});

test('a folder with several DICOM series needs --series-uid', async (t) => {
  const directory = await scratch(t);
  const folder = join(directory, 'dicom');
  await mkdir(folder);
  for (const file of [...dicomSeries({ series: 70 }), ...dicomSeries({ series: 71 })]) {
    await writeFile(join(folder, file.name), file.buffer);
  }
  await assert.rejects(
    encode({ inputs: [folder], output: join(directory, 'ambiguous') }),
    /holds 2 series or volumes[^]*\.99\.70 {2}test_scan_70[^]*\.99\.71 {2}test_scan_71/,
  );
  const uid = '1.2.826.0.1.3680043.10.543.99.71';
  const result = await encode({ inputs: [folder], output: join(directory, 'out'), parameters: { seriesUid: uid, orientation: 'axial', annotate: true } });
  assert.equal(result.source.seriesUid, uid);
  assert.deepEqual(await readdir(join(directory, 'out')), ['test_scan_71_axial.webm']);
  const facts = await inspectVideo(await readFile(result.output));
  assert.deepEqual([facts.codec, facts.width, facts.height, facts.frames], ['vp9', 4, 16, 16]);
  await assert.rejects(
    encode({ inputs: [folder], output: join(directory, 'missing'), parameters: { seriesUid: '1.2.3' } }),
    /No DICOM series has SeriesInstanceUID 1\.2\.3/,
  );
});

test('the output directory must be new or empty', async (t) => {
  const directory = await scratch(t);
  const input = join(directory, 'phantom.nii.gz');
  await writeFile(input, syntheticNifti({ dims: [4, 4, 4] }));
  await writeFile(join(directory, 'taken'), '');
  await assert.rejects(encode({ inputs: [input], output: directory }), /is not empty/);
});

test('distinct DICOM records with the same filename retain every slice', async () => {
  // Like the browser's dcm2niix worker, which writes its inputs into one directory by name.
  const inDirectory = files => convertDicom([...new Map(files.map(file => [file.name, file])).values()]);
  const records = dicomSeries({ series: 72, slices: 2 }).map(file => ({ ...file, name: 'image.dcm' }));
  const bytes = record => record.buffer.buffer.slice(record.buffer.byteOffset, record.buffer.byteOffset + record.buffer.byteLength);
  const { sources } = await discoverSources(records, { readPrefix: async record => bytes(record) });
  assert.equal(sources.length, 1);
  assert.deepEqual(sources[0].recs, records);
  const volume = await loadSource(sources[0], { readBytes: async record => bytes(record), convertDicom: inDirectory });
  assert.deepEqual(volume.dims, [16, 16, 2]);
  assert.deepEqual([...volume.data.subarray(0, 4)], [100, 200, 101, 201]);
});

const asRecords = files => files.map(file => ({
  name: file.name,
  buffer: file.buffer.buffer.slice(file.buffer.byteOffset, file.buffer.byteOffset + file.buffer.byteLength),
}));

test('a series without geometry keeps its stored rows and columns', async () => {
  const volume = await readDicomSeries(asRecords(dicomSeries({ series: 73, slices: 2, geometry: false })), { convertDicom });
  assert.deepEqual(volume.dims, [16, 16, 2]);
  // Pixel (row, column) of slice s holds (s + 1) * 100 + 16 * row + column.
  assert.deepEqual([...volume.data.subarray(0, 4)], [100, 200, 101, 201]);
  assert.equal(volume.data[(1 * 16 + 0) * 2], 116);
});

test('a series dcm2niix splits by echo says it shows only the first image', async () => {
  const files = asRecords(dicomSeries({ series: 74, slices: 2, echoTimes: ['10', '30'] }));
  const volume = await readDicomSeries(files, { convertDicom });
  assert.deepEqual(volume.dims, [16, 16, 2]);
  assert.match(volume.meta.note, /split this series into 2 images/);
});

test('the executable reports usage errors and installs no models', () => {
  const run = (...args) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8' });
  const help = run('--help');
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--color-normalize/);
  assert.match(run('download-models').stdout, /^0 model files/);
  const bad = run('in.nii', 'out', '--fps', '500');
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /--fps must be at most 120/);
  const missing = run('missing.nii', 'out');
  assert.match(missing.stderr, /missing\.nii does not exist/);
});
