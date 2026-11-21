import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Files, gunzip, gzip, isGzip } from '@neurodesk/pipeline-drivers/files';
import { loadMeica } from '@niivue/meica';
import { glmDriver, meicaDriver } from '../src/drivers.js';

/** Minimal float32 NIfTI-1 of `side`^3 voxels, all `value`. */
function nifti(side, value) {
  const n = side ** 3;
  const b = new ArrayBuffer(352 + 4 * n);
  const v = new DataView(b);
  v.setInt32(0, 348, true);
  [3, side, side, side, 1, 1, 1, 1].forEach((d, i) => v.setInt16(40 + 2 * i, d, true));
  v.setInt16(70, 16, true);
  v.setInt16(72, 32, true);
  for (let i = 0; i < 8; i++) v.setFloat32(76 + 4 * i, 1, true);
  v.setFloat32(108, 352, true);
  v.setUint8(123, 2);
  v.setInt16(254, 1, true);
  v.setFloat32(280, 1, true);
  v.setFloat32(300, 1, true);
  v.setFloat32(320, 1, true);
  new Uint8Array(b, 344, 4).set([0x6e, 0x2b, 0x31, 0]);
  new Float32Array(b, 352).fill(value);
  return new Uint8Array(b);
}
const voxel = (bytes) => new DataView(bytes.buffer, bytes.byteOffset).getFloat32(352, true);

test('glm --meica-qc: text inputs in, JSON out; an empty events path means no task', async () => {
  const files = new Files();
  const enc = (s) => new TextEncoder().encode(s);
  for (const p of ['/w/mix.tsv', '/w/metrics.tsv', '/o/conf.tsv', '/o/bold.json', '/d/events.tsv']) files.put(p, enc(p));
  const calls = [];
  const glm = { meica_qc: (...a) => (calls.push(a), '{"conditions":[]}') };
  const run = glmDriver(glm);
  const argv = (events) => ['glm', '--meica-qc', '/w/mix.tsv', '/w/metrics.tsv', '/o/conf.tsv', events, '/o/bold.json', '/w/qc.json'];
  assert.equal((await run(argv('/d/events.tsv'), { files })).code, 0);
  assert.deepEqual(calls[0], ['/w/mix.tsv', '/w/metrics.tsv', '/o/conf.tsv', '/d/events.tsv', '/o/bold.json']);
  assert.equal(await files.text('/w/qc.json'), '{"conditions":[]}');
  await run(argv(''), { files });
  assert.equal(calls[1][3], '');
  await assert.rejects(run(['glm', '--meica-qc', '/w/mix.tsv'], { files }), /expects/);
});

test('meica: the classification call maps onto runMeica; files land under --out-dir', async (t) => {
  const files = new Files();
  const enc = (s) => new TextEncoder().encode(s);
  for (const p of ['/w/e1.nii.gz', '/w/e2.nii.gz', '/w/e3.nii.gz', '/o/mask.nii.gz']) files.put(p, enc(p));
  files.put('/o/conf.tsv', enc('trans_x\n0\n'));
  const seen = [];
  const api = {
    Session: class {
      add_echo(name) { seen.push(['echo', name]); }
      set_mask(b) { seen.push(['mask', b.length]); }
      run(o) { seen.push(['run', JSON.parse(o)]); return '{}'; }
      file_count() { return 1; }
      file_name() { return 'desc-tedana_metrics.tsv'; }
      take_file() { return enc('Component\tclassification\n'); }
      free() {}
    },
  };
  const argv = ['meica', '-d', '/w/e1.nii.gz', '/w/e2.nii.gz', '/w/e3.nii.gz', '-e', '15.2', '35.32', '55.42', '--mask',
    '/o/mask.nii.gz', '--dummy-scans', '1', '--tree', 'motion_f', '--external', '/o/conf.tsv', '--n-threads', '8',
    '--quiet', '--out-dir', '/w/meica_motion_f'];
  assert.equal((await meicaDriver(api)(argv, { files })).code, 0);
  assert.deepEqual(seen.slice(0, 3).map((s) => s[1]), ['/w/e1.nii.gz', '/w/e2.nii.gz', '/w/e3.nii.gz']);
  assert.deepEqual(seen.at(-1)[1], { tree: 'motion_f', dummy_scans: 1, external: 'trans_x\n0\n', tes: [15.2, 35.32, 55.42] });
  assert.ok(files.has('/w/meica_motion_f/desc-tedana_metrics.tsv'));
  await assert.rejects(meicaDriver(api)(['meica', '--moco'], { files }), /not supported/);
  for (const [extra, error] of [
    [['--quiet', '--not-supported'], /--not-supported.*not supported/],
    [['--quiet', 'extra'], /extra.*not supported/],
    [['--tree', 'motion_f', 'extra'], /extra.*not supported/],
    [['-d', '/w/e1.nii.gz', '--not-supported'], /--not-supported.*not supported/],
    [['--tree'], /--tree needs 1 value/],
    [['--tree', '--quiet'], /--tree needs 1 value/],
    [['-e', '--quiet'], /-e needs at least 1 value/],
    [['-d'], /-d needs at least 1 value/],
  ]) {
    await t.test(`rejects ${extra.join(' ')}`, async () => {
      await assert.rejects(meicaDriver(api)([...argv, ...extra], { files }), error);
    });
  }
});

test('meica --denoise: the rejected column is removed, dummies pass through, gzip follows the name', async () => {
  const files = new Files();
  // 2 voxels x 5 volumes (float32), 1 dummy; voxel 0 is the rejected ramp plus its mean, voxel 1 orthogonal to it
  const series = [[9, 1, 2, 3, 4], [9, 4, 6, 6, 4]];
  const v = new DataView(new ArrayBuffer(352 + 40));
  v.setInt32(0, 348, true);
  [4, 2, 1, 1, 5, 1, 1, 1].forEach((d, i) => v.setInt16(40 + 2 * i, d, true));
  v.setInt16(70, 16, true);
  v.setInt16(72, 32, true);
  v.setFloat32(108, 352, true);
  series.forEach((ts, x) => ts.forEach((y, t) => v.setFloat32(352 + 4 * (t * 2 + x), y, true)));
  files.put('/o/bold.nii', new Uint8Array(v.buffer));
  files.put('/w/mix.tsv', new TextEncoder().encode('ICA_00\n-1.5\n-0.5\n0.5\n1.5\n'));
  files.put('/w/metrics.tsv', new TextEncoder().encode('Component\tclassification\nICA_00\trejected\n'));
  const run = meicaDriver(() => loadMeica({ threads: 1 })); // the lazy form the app worker passes
  const out = '/o/den.nii.gz';
  await run(['meica', '--denoise', '/o/bold.nii', '--mixing', '/w/mix.tsv', '--metrics', '/w/metrics.tsv', '--dummy-scans', '1', '-o', out], { files });
  const raw = await files.bytes(out);
  const b = isGzip(raw) ? await gunzip(raw) : raw;
  const y = (x, t) => new DataView(b.buffer, b.byteOffset).getFloat32(352 + 4 * (t * 2 + x), true);
  assert.equal(y(0, 0), 9);
  for (let t = 1; t < 5; t++) assert.ok(Math.abs(y(0, t) - 2.5) < 1e-6);
  for (let t = 1; t < 5; t++) assert.equal(y(1, t), series[1][t]);
});
