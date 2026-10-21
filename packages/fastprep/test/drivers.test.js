import { test } from 'node:test';
import assert from 'node:assert/strict';
import createNiimath from '@niivue/niimath/niimath.js';
import { Files, gzip, isGzip } from '../src/files.js';
import { glmDriver, greedyDriver, mindgrabDriver, niimathDriver } from '../src/drivers.js';

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

test('niimath: nested paths, side outputs and raw .nii.zst intermediates', async () => {
  const files = new Files();
  files.put('/work/sub-01/anat/in.nii', nifti(4, 1));
  const niimath = niimathDriver(createNiimath);
  const r = await niimath(
    ['niimath', '/work/sub-01/anat/in.nii', '-add', '1', '-save', '/work/sub-01/anat/side', '-mul', '2', '/work/sub-01/anat/out.nii.zst'],
    { files, fslOut: 'NIFTI_ZST' },
  );
  assert.equal(r.code, 0, r.stdout);
  assert.equal(voxel(await files.bytes('/work/sub-01/anat/side.nii.zst')), 2); // extensionless -save follows the type
  assert.equal(voxel(await files.bytes('/work/sub-01/anat/out.nii.zst')), 4);
  // a later step reads the .zst name; default output type is gzip, as the native environment
  const r2 = await niimath(['niimath', '/work/sub-01/anat/out.nii.zst', '-sub', '1', '/out/sub-01/x.nii.gz'], { files });
  assert.equal(r2.code, 0, r2.stdout);
  assert.ok(isGzip(await files.bytes('/out/sub-01/x.nii.gz')));
  const bad = await niimath(['niimath', '/work/sub-01/anat/missing.nii', '-add', '1', '/out/y.nii.gz'], { files });
  assert.notEqual(bad.code, 0);
  assert.ok(!files.has('/out/y.nii.gz'));
});

test('greedy: the core\'s three command forms map onto the WASM exports', async () => {
  const files = new Files();
  for (const p of ['/t/brain.nii.gz', '/t/t1.nii.gz', '/t/mask.nii.gz', '/a/brain.nii.gz', '/a/fov.nii.gz', '/a/preproc.nii.gz']) {
    files.put(p, await gzip(nifti(2, 1)));
  }
  const calls = [];
  const api = {
    register_affine_masked_wasm: (f, m, mask, metric, it) => (calls.push(['affine', mask, metric, it]), '1 0 0 0\n0 1 0 0\n0 0 1 0\n0 0 0 1\n'),
    register_nmi_svf_masked_wasm: (f, m, mask, init, it) => (calls.push(['svf', Boolean(mask), init, it]), nifti(2, 0)),
    reslice_warp_affine_options: (f, m, w, mat, pre, nearest) => (calls.push(['reslice', nearest]), nifti(2, 3)),
  };
  const greedy = greedyDriver(api);
  const g = ['greedy-rs', '-d', '3', '-threads', '8', '-V', '0', '-m', 'NMI', '-n', '100x50x10'];
  await greedy([...g, '-i', '/t/brain.nii.gz', '/a/brain.nii.gz', '-a', '-ia-image-centers', '-o', '/o/aff.mat'], { files });
  await greedy([...g, '-i', '/t/t1.nii.gz', '/a/fov.nii.gz', '-gm', '/t/mask.nii.gz', '-it', '/o/aff.mat', '-sv', '-o', '/o/warp.nii.gz'], { files });
  await greedy(['greedy-rs', '-d', '3', '-threads', '8', '-rf', '/t/brain.nii.gz', '-ri', 'NN', '-rm', '/a/preproc.nii.gz', '/o/r.nii.gz', '-r', '/o/warp.nii.gz', '/o/aff.mat'], { files });
  assert.deepEqual(calls, [
    ['affine', undefined, 'NMI', '100x50x10'],
    ['svf', true, '1 0 0 0\n0 1 0 0\n0 0 1 0\n0 0 0 1\n', '100x50x10'],
    ['reslice', true],
  ]);
  assert.ok(isGzip(await files.bytes('/o/warp.nii.gz')) && isGzip(await files.bytes('/o/r.nii.gz')));
  await assert.rejects(greedy(['greedy-rs', '-unknown'], { files }), /not supported/);
});

test('mindgrab: brain, mask and tissue maps land on the native names', async () => {
  const files = new Files();
  files.put('/a/t1.nii.gz', await gzip(nifti(2, 1)));
  const seen = [];
  const mg = {
    segment: async (_b, o) => (seen.push(o), { image: nifti(2, 1).buffer, mask: nifti(2, 1).buffer }),
    segmentTissues: async (_b, o) => (seen.push(o), { tissues: { gm: nifti(2, 1).buffer, wm: nifti(2, 2).buffer, csf: nifti(2, 3).buffer } }),
  };
  const run = mindgrabDriver(mg, { backend: 'cpu' });
  await run(['brainchop-mindgrab', '-o', '/w/brain.nii.gz', '--mask', '/o/mask.nii.gz', '/a/t1.nii.gz'], { files });
  await run(['brainchop-mindmap', '--pve', '-o', '/w/pve.nii.gz', '/a/t1.nii.gz'], { files });
  assert.deepEqual(seen.map((o) => [o.model, o.mask, o.backend, o.gzipOutput]), [['mindgrab', true, 'cpu', true], ['mindmap', undefined, 'cpu', true]]);
  for (const p of ['/w/brain.nii.gz', '/o/mask.nii.gz', '/w/pve_gm.nii.gz', '/w/pve_wm.nii.gz', '/w/pve_csf.nii.gz']) assert.ok(files.has(p), p);
  assert.ok(isGzip(await files.bytes('/o/mask.nii.gz'))); // the fake returned raw bytes: gzip follows the name
});

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
