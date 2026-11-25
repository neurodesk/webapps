import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import {
  MODEL_ASSETS,
  checkInstallation,
  defaultCacheDir,
  downloadModels,
  resolveThreads,
  segment,
} from '../src/node.js';
import { parseNiftiHeader, readNiftiVolume, writeNiftiUint8 } from '../src/nifti.js';
import { resolveTaskPlan } from '../src/models.js';

const BIN = fileURLToPath(new URL('../bin/totalsegmentator.js', import.meta.url));
const NIFTI2_MAGIC = [0x6e, 0x2b, 0x32, 0x00, 0x0d, 0x0a, 0x1a, 0x0a];

function makeNifti1({
  dims = [4, 4, 4],
  data = new Float32Array(dims[0] * dims[1] * dims[2]),
  pixdim = [1, 2, 2, 2, 0, 0, 0, 0],
  qformCode = 0,
  sformCode = 1,
  quatern = [0, 0, 0],
  qoffset = [0, 0, 0],
  srow = [
    [2, 0, 0, 0],
    [0, 2, 0, 0],
    [0, 0, 2, 0],
  ],
  xyztUnits = 2,
} = {}) {
  const buf = new ArrayBuffer(352 + data.length * 4);
  const v = new DataView(buf);
  v.setInt32(0, 348, true);
  v.setInt16(40, 3, true);
  for (let i = 0; i < 3; i++) v.setInt16(42 + i * 2, dims[i], true);
  for (let i = 3; i < 7; i++) v.setInt16(42 + i * 2, 1, true);
  v.setInt16(70, 16, true);
  v.setInt16(72, 32, true);
  for (let i = 0; i < 8; i++) v.setFloat32(76 + i * 4, pixdim[i] ?? 0, true);
  v.setFloat32(108, 352, true);
  v.setFloat32(112, 1, true);
  v.setUint8(123, xyztUnits);
  v.setInt16(252, qformCode, true);
  v.setInt16(254, sformCode, true);
  for (let i = 0; i < 3; i++) v.setFloat32(256 + i * 4, quatern[i], true);
  for (let i = 0; i < 3; i++) v.setFloat32(268 + i * 4, qoffset[i], true);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 4; c++) v.setFloat32(280 + (r * 4 + c) * 4, srow[r][c], true);
  }
  new Uint8Array(buf, 344, 4).set([110, 43, 49, 0]);
  for (let i = 0; i < data.length; i++) v.setFloat32(352 + i * 4, data[i], true);
  return Buffer.from(buf);
}

function makeNifti2({
  dims = [4, 4, 4],
  data = new Uint8Array(dims[0] * dims[1] * dims[2]),
  pixdim = [1, 2, 3, 4, 0, 0, 0, 0],
  qformCode = 1,
  sformCode = 0,
  quatern = [0, 0, 0],
  qoffset = [10, -20, 30],
  srow = [
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ],
  xyztUnits = 2,
} = {}) {
  const buf = new ArrayBuffer(544 + data.length);
  const v = new DataView(buf);
  v.setInt32(0, 540, true);
  new Uint8Array(buf, 4, 8).set(NIFTI2_MAGIC);
  v.setInt16(12, 2, true);
  v.setInt16(14, 8, true);
  v.setBigInt64(16, 3n, true);
  for (let i = 0; i < 3; i++) v.setBigInt64(24 + i * 8, BigInt(dims[i]), true);
  for (let i = 3; i < 7; i++) v.setBigInt64(24 + i * 8, 1n, true);
  for (let i = 0; i < 8; i++) v.setFloat64(104 + i * 8, pixdim[i] ?? 0, true);
  v.setBigInt64(168, 544n, true);
  v.setFloat64(176, 1, true);
  v.setInt32(344, qformCode, true);
  v.setInt32(348, sformCode, true);
  for (let i = 0; i < 3; i++) v.setFloat64(352 + i * 8, quatern[i], true);
  for (let i = 0; i < 3; i++) v.setFloat64(376 + i * 8, qoffset[i], true);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 4; c++) v.setFloat64(400 + (r * 4 + c) * 8, srow[r][c], true);
  }
  v.setInt32(500, xyztUnits, true);
  new Uint8Array(buf, 544).set(data);
  return Buffer.from(buf);
}

describe('NIfTI-1 and NIfTI-2 reader/writer (NiBabel parity)', () => {
  it('prefers sform over qform even when qform_code > sform_code and preserves both transforms', () => {
    const src = makeNifti1({
      qformCode: 2,
      sformCode: 1,
      quatern: [0, 0, 0],
      qoffset: [1, 2, 3],
      srow: [
        [-2, 0, 0, 50],
        [0, 2, 0, -30],
        [0, 0, 3, 12],
      ],
    });
    const vol = readNiftiVolume(src);
    // NiBabel prefers sform_code=1 over qform_code=2, preserving the left-right flip and translation.
    assert.deepEqual(vol.affine, [
      [-2, 0, 0, 50],
      [0, 2, 0, -30],
      [0, 0, 3, 12],
      [0, 0, 0, 1],
    ]);

    const labels = new Uint8Array(64).fill(5);
    const outBuf = writeNiftiUint8({ data: labels, dims: vol.dims, affine: vol.affine, header: vol.header });
    const outHdr = parseNiftiHeader(outBuf);
    assert.equal(outHdr.niftiVersion, 1);
    assert.equal(outHdr.qformCode, 2);
    assert.equal(outHdr.sformCode, 1);
    assert.deepEqual(outHdr.qoffset, [1, 2, 3]);
    assert.deepEqual(outHdr.srow, [
      [-2, 0, 0, 50],
      [0, 2, 0, -30],
      [0, 0, 3, 12],
    ]);
    assert.deepEqual(outHdr.affine, vol.affine);
  });

  it('reads qform-only NIfTI-2 volumes with qfac=-1 and preserves qform in NIfTI-2 output', () => {
    const src = makeNifti2({
      pixdim: [-1, 1.5, 2.0, 2.5, 0, 0, 0, 0],
      qformCode: 1,
      sformCode: 0,
      quatern: [0, 0, 1], // 180 deg rotation around Z -> X and Y flipped
      qoffset: [10, -20, 30],
    });
    const vol = readNiftiVolume(src);
    assert.equal(vol.header.niftiVersion, 2);
    assert.ok(Math.abs(vol.affine[0][0] - (-1.5)) < 1e-6);
    assert.ok(Math.abs(vol.affine[1][1] - (-2.0)) < 1e-6);
    assert.ok(Math.abs(vol.affine[2][2] - (-2.5)) < 1e-6); // qfac = -1
    assert.deepEqual([vol.affine[0][3], vol.affine[1][3], vol.affine[2][3]], [10, -20, 30]);

    const outBuf = writeNiftiUint8({
      data: new Uint8Array(64).fill(3),
      dims: vol.dims,
      affine: vol.affine,
      header: vol.header,
    });
    const outHdr = parseNiftiHeader(outBuf);
    assert.equal(outHdr.niftiVersion, 2);
    assert.equal(outHdr.qformCode, 1);
    assert.equal(outHdr.sformCode, 0);
    assert.deepEqual(outHdr.qoffset, [10, -20, 30]);
    assert.equal(outHdr.pixdim[0], -1);
  });

  it('uses NiBabel LAS centered fallback affine when both qform_code and sform_code are 0', () => {
    const src = makeNifti1({
      dims: [5, 7, 9],
      pixdim: [1, 2, 3, 4, 0, 0, 0, 0],
      qformCode: 0,
      sformCode: 0,
    });
    const vol = readNiftiVolume(src);
    assert.deepEqual(vol.affine, [
      [-2, 0, 0, 4],
      [0, 3, 0, -9],
      [0, 0, 4, -16],
      [0, 0, 0, 1],
    ]);
  });

  it('rejects FLOAT64 voxels that overflow to Infinity in Float32Array', () => {
    const buf = new ArrayBuffer(352 + 8 * 8);
    const v = new DataView(buf);
    v.setInt32(0, 348, true);
    v.setInt16(40, 3, true);
    v.setInt16(42, 2, true);
    v.setInt16(44, 2, true);
    v.setInt16(46, 2, true);
    for (let i = 3; i < 7; i++) v.setInt16(42 + i * 2, 1, true);
    v.setInt16(70, 64, true);
    v.setInt16(72, 64, true);
    v.setFloat32(76, 1, true);
    v.setFloat32(80, 1, true);
    v.setFloat32(84, 1, true);
    v.setFloat32(88, 1, true);
    v.setFloat32(108, 352, true);
    v.setFloat32(112, 1, true);
    v.setUint8(123, 2);
    v.setInt16(254, 1, true);
    v.setFloat32(280, 1, true);
    v.setFloat32(300, 1, true);
    v.setFloat32(320, 1, true);
    new Uint8Array(buf, 344, 4).set([110, 43, 49, 0]);
    v.setFloat64(352, 1e100, true);
    assert.throws(() => readNiftiVolume(buf), /non-finite intensities/);
  });

  it('round-trips oversized NIfTI-2 dimensions (> 32767) without signed int16 overflow', () => {
    const dims = [32768, 2, 2];
    const src = makeNifti2({
      dims,
      data: new Uint8Array(32768 * 2 * 2),
      qformCode: 1,
      sformCode: 0,
    });
    const vol = readNiftiVolume(src);
    assert.deepEqual(vol.dims, [32768, 2, 2]);

    const outBuf = writeNiftiUint8({
      data: new Uint8Array(32768 * 2 * 2),
      dims: vol.dims,
      affine: vol.affine,
      header: vol.header,
    });
    const outHdr = parseNiftiHeader(outBuf);
    assert.equal(outHdr.niftiVersion, 2);
    assert.deepEqual(outHdr.dim.slice(1, 4), [32768, 2, 2]);
  });
});

describe('TotalSegmentator Node API and CLI (offline)', () => {
  it('checks ONNX Runtime CPU installation and exposes all 12 model assets', async () => {
    assert.equal(MODEL_ASSETS.length, 12);
    const prev = process.env.NEURODESK_TOTALSEGMENTATOR_MODEL_DIR;
    delete process.env.NEURODESK_TOTALSEGMENTATOR_MODEL_DIR;
    try {
      const info = await checkInstallation();
      assert.equal(info.executionProvider, 'cpu');
      assert.equal(info.node, process.version);
      assert.equal(info.executable, process.execPath);
      assert.match(info.onnxRuntime, /^\d+\.\d+/);
      assert.equal(info.models, undefined);
    } finally {
      if (prev !== undefined) process.env.NEURODESK_TOTALSEGMENTATOR_MODEL_DIR = prev;
    }
  });

  it('validates thread counts, cache directories, and fixed-resolution task options', () => {
    assert.equal(resolveThreads(4), 4);
    assert.equal(resolveThreads('2'), 2);
    assert.throws(() => resolveThreads(0), /positive integer/);
    assert.throws(() => resolveThreads('1.5'), /positive integer/);
    assert.throws(() => resolveThreads('abc'), /positive integer/);

    assert.equal(resolveTaskPlan({ task: 'vertebrae_mr' }).resolution, 'full');
    assert.equal(resolveTaskPlan({ task: 'abdominal_muscles', resolution: 'full' }).resolution, 'full');
    assert.throws(() => resolveTaskPlan({ task: 'vertebrae_mr', resolution: 'fast' }), /only supports full resolution/);
    assert.throws(() => resolveTaskPlan({ task: 'abdominal_muscles', resolution: 'typo' }), /only supports full resolution/);

    const prev = process.env.NEURODESK_TOTALSEGMENTATOR_MODEL_DIR;
    process.env.NEURODESK_TOTALSEGMENTATOR_MODEL_DIR = '/tmp/totalseg-models-override';
    try {
      assert.equal(defaultCacheDir(), '/tmp/totalseg-models-override');
    } finally {
      if (prev === undefined) delete process.env.NEURODESK_TOTALSEGMENTATOR_MODEL_DIR;
      else process.env.NEURODESK_TOTALSEGMENTATOR_MODEL_DIR = prev;
    }
  });

  it('rejects corrupt gzip, accepts multi-member gzip, enforces output locks, and cleans up failed runs', async () => {
    const work = await mkdtemp(join(tmpdir(), 'totalseg-node-test-'));
    try {
      const scanBytes = makeNifti1();
      const scanPath = join(work, 'scan.nii.gz');
      const gz = gzipSync(scanBytes);
      await writeFile(scanPath, gz);

      // Corrupt gzip CRC/payload must be rejected before model lookup.
      const corruptGz = Buffer.from(gz);
      corruptGz[corruptGz.length - 5] ^= 0xff;
      const corruptPath = join(work, 'corrupt.nii.gz');
      await writeFile(corruptPath, corruptGz);
      const corruptOut = join(work, 'corrupt-out');
      await assert.rejects(
        () => segment({ input: corruptPath, output: corruptOut, cacheDir: join(work, 'empty-cache'), offline: true }),
        /Corrupt or invalid gzipped NIfTI input/,
      );
      // Failed run into a newly created destination cleans up the empty directory so retry works.
      await assert.rejects(() => stat(corruptOut), { code: 'ENOENT' });

      // Valid two-member gzip must decode cleanly (and reach the offline model check).
      const split = Math.floor(scanBytes.length / 2);
      const twoMember = Buffer.concat([
        gzipSync(scanBytes.subarray(0, split)),
        gzipSync(scanBytes.subarray(split)),
      ]);
      const twoMemberPath = join(work, 'two-member.nii.gz');
      await writeFile(twoMemberPath, twoMember);
      await assert.rejects(
        () => segment({ input: twoMemberPath, output: join(work, 'two-member-out'), cacheDir: join(work, 'empty-cache'), offline: true }),
        /missing from the offline model directory/,
      );

      // Exclusive lock file in destination blocks concurrent runs immediately.
      const lockedOut = join(work, 'locked-out');
      await mkdir(lockedOut);
      await writeFile(join(lockedOut, '.totalsegmentator.lock'), '99999\n');
      await assert.rejects(
        () => segment({ input: scanPath, output: lockedOut, cacheDir: join(work, 'empty-cache'), offline: true }),
        /already in use/,
      );

      // Existing non-empty directory is refused without deleting its contents.
      const nonEmpty = join(work, 'existing');
      await mkdir(nonEmpty);
      await writeFile(join(nonEmpty, 'keep.txt'), 'keep');
      await assert.rejects(
        () => segment({ input: scanPath, output: nonEmpty, offline: true }),
        /not empty/,
      );
      assert.deepEqual(await readdir(nonEmpty), ['keep.txt']);

      // Existing file as output path.
      const fileOut = join(work, 'not-a-dir');
      await writeFile(fileOut, 'x');
      await assert.rejects(
        () => segment({ input: scanPath, output: fileOut, offline: true }),
        /not a directory/,
      );

      // Corrupt cached model rejected offline.
      const badCache = join(work, 'bad-cache');
      await mkdir(badCache);
      await writeFile(join(badCache, 'totalsegmentator-total-ct-3mm.onnx'), 'corrupt');
      await assert.rejects(
        () => downloadModels({ task: 'total', resolution: 'fast', cacheDir: badCache, offline: true }),
        /failed checksum verification/,
      );

      // downloadModels and segment reject empty cacheDir and empty subset before claiming output or accessing models.
      await assert.rejects(
        () => segment({ input: scanPath, output: join(work, 'empty-cache-out'), cacheDir: '', offline: true }),
        /cacheDir must be a non-empty path/,
      );
      await assert.rejects(() => stat(join(work, 'empty-cache-out')), { code: 'ENOENT' });
      await assert.rejects(
        () => segment({ input: scanPath, output: join(work, 'empty-subset-out'), subset: '', offline: true }),
        /requires full resolution/,
      );
      await assert.rejects(() => stat(join(work, 'empty-subset-out')), { code: 'ENOENT' });
      await assert.rejects(
        () => downloadModels({ task: 'total', subset: '', cacheDir: badCache, offline: true }),
        /requires full resolution/,
      );

      // downloadModels rejects --resolution / --subset when --task is omitted.
      await assert.rejects(
        () => downloadModels({ resolution: 'typo', cacheDir: badCache, offline: true }),
        /require --task/,
      );
      await assert.rejects(
        () => downloadModels({ subset: 'typo', cacheDir: badCache, offline: true }),
        /require --task/,
      );
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  it('validates CLI subcommand flags and honors self-check --cache-dir', async () => {
    const help = execFileSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
    assert.match(help, /Usage: totalsegmentator/);
    assert.match(help, /abdominal_muscles/);

    const env = { ...process.env };
    delete env.NEURODESK_TOTALSEGMENTATOR_MODEL_DIR;
    const checkOut = execFileSync(process.execPath, [BIN, 'self-check'], { encoding: 'utf8', env });
    const parsed = JSON.parse(checkOut);
    assert.equal(parsed.executionProvider, 'cpu');
    assert.equal(parsed.node, process.version);

    const work = await mkdtemp(join(tmpdir(), 'totalseg-cli-flags-'));
    try {
      const emptyCache = join(work, 'empty-models');
      await mkdir(emptyCache);
      // self-check --cache-dir must inspect the specified directory rather than ignoring it.
      assert.throws(
        () => execFileSync(process.execPath, [BIN, 'self-check', '--cache-dir', emptyCache], { encoding: 'utf8', env, stdio: 'pipe' }),
        (err) => err.status === 1 && /missing from the offline model directory/.test(err.stderr),
      );
      // self-check rejects unsupported flags.
      assert.throws(
        () => execFileSync(process.execPath, [BIN, 'self-check', '--task', 'total'], { encoding: 'utf8', env, stdio: 'pipe' }),
        (err) => err.status === 1 && /does not accept option: --task/.test(err.stderr),
      );
      // download-models rejects --resolution/--subset without --task, empty options, and --threads.
      assert.throws(
        () => execFileSync(process.execPath, [BIN, 'download-models', '--resolution', 'typo', '--subset', 'typo'], { encoding: 'utf8', env, stdio: 'pipe' }),
        (err) => err.status === 1 && /require --task/.test(err.stderr),
      );
      assert.throws(
        () => execFileSync(process.execPath, [BIN, 'download-models', '--task='], { encoding: 'utf8', env, stdio: 'pipe' }),
        (err) => err.status === 1 && /requires a non-empty value/.test(err.stderr),
      );
      assert.throws(
        () => execFileSync(process.execPath, [BIN, 'self-check', '--cache-dir='], { encoding: 'utf8', env, stdio: 'pipe' }),
        (err) => err.status === 1 && /requires a non-empty value/.test(err.stderr),
      );
      assert.throws(
        () => execFileSync(process.execPath, [BIN, 'download-models', '--threads', '4'], { encoding: 'utf8', env, stdio: 'pipe' }),
        (err) => err.status === 1 && /does not accept option: --threads/.test(err.stderr),
      );
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });
});
