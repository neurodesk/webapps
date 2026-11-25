import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import {
  parseNiftiVolumeHeader,
  readNiftiVolume,
  writeNiftiVolume,
} from '@neurodesk/webapp-components/file-io/nifti-volume';
import { analyze, checkInstallation, defaultCacheDir, downloadModels, validateParameters } from '../src/node.js';

const BIN = fileURLToPath(new URL('../bin/tumour-report.js', import.meta.url));

function makeSyntheticVolume(dims = [12, 12, 12], { qformCode = 2, sformCode = 1, sformShiftX = 0, version = 1 } = {}) {
  const [nx, ny, nz] = dims;
  const data = new Float32Array(nx * ny * nz);
  const mask = new Uint8Array(nx * ny * nz);
  for (let z = 0; z < nz; z += 1) {
    for (let y = 0; y < ny; y += 1) {
      for (let x = 0; x < nx; x += 1) {
        const idx = x + nx * (y + ny * z);
        if (x >= 2 && x <= 9 && y >= 2 && y <= 9 && z >= 2 && z <= 9) {
          data[idx] = 100;
        }
        if (x >= 4 && x <= 6 && y >= 4 && y <= 6 && z >= 4 && z <= 6) {
          data[idx] = 250;
          mask[idx] = 1;
        }
      }
    }
  }
  const affine = [
    [1, 0, 0, -6 + sformShiftX],
    [0, 1, 0, -6],
    [0, 0, 1, -6],
    [0, 0, 0, 1],
  ];
  const transforms = {
    qformCode,
    sformCode,
    pixdim0: 1,
    pixDims: [1, 1, 1],
    quaternB: 0,
    quaternC: 0,
    quaternD: 0,
    qoffsetX: -6,
    qoffsetY: -6,
    qoffsetZ: -6,
    srowX: affine[0],
    srowY: affine[1],
    srowZ: affine[2],
    xyztUnits: 2,
  };
  return {
    t1c: Buffer.from(writeNiftiVolume({ data, dims, affine, transforms, version }, 'synthetic T1c')),
    mask: Buffer.from(writeNiftiVolume({ data: mask, dims, affine, transforms, version }, 'synthetic tumour mask')),
    dims,
    affine,
  };
}

function runBin(args, env = process.env) {
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    env,
  });
}

test('validateParameters enforces tumourType and boolean flags', () => {
  assert.deepEqual(validateParameters({}), {
    tumourType: 'glioblastoma',
    computeMniReport: true,
    deformableMni: false,
    skullStripped: false,
  });
  assert.deepEqual(
    validateParameters({ tumourType: 'metastasis', computeMniReport: false, deformableMni: true, skullStripped: true }),
    { tumourType: 'metastasis', computeMniReport: false, deformableMni: true, skullStripped: true },
  );
  assert.throws(() => validateParameters({ tumourType: '' }), /tumourType/);
  assert.throws(() => validateParameters({ tumourType: 'unknown' }), /tumourType/);
  assert.throws(() => validateParameters({ computeMniReport: 'yes' }), /boolean/);
});

test('defaultCacheDir honors NEURODESK_TUMOUR_REPORT_MODEL_DIR and rejects empty value', () => {
  const prev = process.env.NEURODESK_TUMOUR_REPORT_MODEL_DIR;
  try {
    process.env.NEURODESK_TUMOUR_REPORT_MODEL_DIR = '/custom/tumour-models';
    assert.equal(defaultCacheDir(), '/custom/tumour-models');
    process.env.NEURODESK_TUMOUR_REPORT_MODEL_DIR = '   ';
    assert.throws(() => defaultCacheDir(), /non-empty/);
  } finally {
    if (prev === undefined) delete process.env.NEURODESK_TUMOUR_REPORT_MODEL_DIR;
    else process.env.NEURODESK_TUMOUR_REPORT_MODEL_DIR = prev;
  }
});

test('ORT_DISABLE_TELEMETRY is forced to 1 unconditionally even when inherited as 0', () => {
  assert.equal(process.env.ORT_DISABLE_TELEMETRY, '1');
  const nodeModuleUrl = new URL('../src/node.js', import.meta.url).href;
  const probe = spawnSync(
    process.execPath,
    ['-e', `import(${JSON.stringify(nodeModuleUrl)}).then(() => console.log(process.env.ORT_DISABLE_TELEMETRY))`],
    { encoding: 'utf8', env: { ...process.env, ORT_DISABLE_TELEMETRY: '0' } },
  );
  assert.equal(probe.status, 0, probe.stderr);
  assert.equal(probe.stdout.trim(), '1');
});

test('checkInstallation verifies ONNX Runtime CPU, Greedy WASM, and explicit cacheDir', async () => {
  const prev = process.env.NEURODESK_TUMOUR_REPORT_MODEL_DIR;
  delete process.env.NEURODESK_TUMOUR_REPORT_MODEL_DIR;
  const emptyDir = await mkdtemp(join(tmpdir(), 'tumour-selfcheck-'));
  try {
    const info = await checkInstallation();
    assert.equal(info.ok, true);
    assert.equal(info.executable, process.execPath);
    assert.equal(info.node, process.version);
    assert.equal(info.executionProvider, 'cpu');
    assert.equal(info.greedy, 'wasm-single');
    assert.equal(typeof info.onnxRuntime, 'string');
    assert.equal(info.assets, 10);
    assert.equal(info.modelsVerified, false);

    // Explicit --cache-dir verifies pinned models and fails when missing.
    await assert.rejects(checkInstallation({ cacheDir: emptyDir }), /missing from model directory/);
    await assert.rejects(checkInstallation({ cacheDir: '' }), /non-empty/);
  } finally {
    if (prev !== undefined) process.env.NEURODESK_TUMOUR_REPORT_MODEL_DIR = prev;
    await rm(emptyDir, { recursive: true, force: true });
  }
});

test('downloadModels refuses missing assets in offline mode and rejects empty cacheDir', async () => {
  const emptyDir = await mkdtemp(join(tmpdir(), 'tumour-offline-'));
  try {
    await assert.rejects(downloadModels({ cacheDir: '', offline: true }), /non-empty/);
    await assert.rejects(
      downloadModels({ cacheDir: emptyDir, offline: true }),
      /missing from offline model directory/,
    );
  } finally {
    await rm(emptyDir, { recursive: true, force: true });
  }
});

test('analyze preserves qform+sform, rejects 100mm sform-shifted mask, supports NIfTI-2 and two-member gzip, and locks output dir', async () => {
  const work = await mkdtemp(join(tmpdir(), 'tumour-supplied-'));
  try {
    const synth = makeSyntheticVolume([12, 12, 12], { qformCode: 2, sformCode: 1 });
    const t1cPath = join(work, 'sub-01_T1c.nii');
    const maskPath = join(work, 'sub-01_mask.nii');
    const outDir = join(work, 'out');
    await writeFile(t1cPath, synth.t1c);
    await writeFile(maskPath, synth.mask);

    const summary = await analyze({
      input: t1cPath,
      mask: maskPath,
      output: outDir,
      offline: true,
      parameters: { tumourType: 'meningioma', computeMniReport: false, skullStripped: true },
    });

    assert.equal(summary.caseLabel, 'sub-01_T1c');
    assert.equal(summary.lesionCount, 1);
    assert.equal(summary.totalVolumeMl, 0.027);
    assert.equal(summary.provenance.mode, 'supplied-mask');

    const writtenHeader = parseNiftiVolumeHeader(await readFile(join(outDir, 'sub-01_T1c_tumour_mask.nii')));
    assert.equal(writtenHeader.qformCode, 2);
    assert.equal(writtenHeader.sformCode, 1);
    assert.equal(writtenHeader.transforms.qoffsetX, -6);
    assert.equal(writtenHeader.transforms.srowX[3], -6);

    // Conflicting qform_code=2 vs 100 mm shifted sform_code=1 on supplied mask MUST be rejected!
    const shiftedMask = makeSyntheticVolume([12, 12, 12], { qformCode: 2, sformCode: 1, sformShiftX: 100 }).mask;
    const shiftedMaskPath = join(work, 'shifted_mask.nii');
    await writeFile(shiftedMaskPath, shiftedMask);
    const shiftedOut = join(work, 'out-shifted');
    await assert.rejects(
      analyze({
        input: t1cPath,
        mask: shiftedMaskPath,
        output: shiftedOut,
        offline: true,
        parameters: { tumourType: 'meningioma', computeMniReport: false, skullStripped: true },
      }),
      /not aligned/,
    );
    // Failed run cleans up newly created output directory.
    await assert.rejects(access(shiftedOut), { code: 'ENOENT' });

    // Qform-only NIfTI-2 round-trip + two-member gzip input
    const v2 = makeSyntheticVolume([12, 12, 12], { qformCode: 1, sformCode: 0, version: 2 });
    const mid = Math.floor(v2.t1c.length / 2);
    const twoMemberGz = Buffer.concat([gzipSync(v2.t1c.subarray(0, mid)), gzipSync(v2.t1c.subarray(mid))]);
    const t1cV2Path = join(work, 'sub-02_T1c.nii.gz');
    const maskV2Path = join(work, 'sub-02_mask.nii');
    const outV2 = join(work, 'out-v2');
    await writeFile(t1cV2Path, twoMemberGz);
    await writeFile(maskV2Path, v2.mask);
    const v2Summary = await analyze({
      input: t1cV2Path,
      mask: maskV2Path,
      output: outV2,
      offline: true,
      parameters: { tumourType: 'glioblastoma', computeMniReport: false, skullStripped: true },
    });
    assert.equal(v2Summary.lesionCount, 1);
    const v2OutVol = readNiftiVolume(await readFile(join(outV2, 'sub-02_T1c_tumour_mask.nii')));
    assert.equal(v2OutVol.version, 2);
    assert.equal(v2OutVol.transforms.qformCode, 1);
    assert.equal(v2OutVol.transforms.sformCode, 0);

    // Pre-existing exclusive lock file blocks concurrent runs.
    const lockedDir = join(work, 'locked');
    await mkdir(lockedDir);
    await writeFile(join(lockedDir, '.tumour-report.lock'), '{"pid":1}\n');
    await assert.rejects(
      analyze({
        input: t1cPath,
        mask: maskPath,
        output: lockedDir,
        offline: true,
        parameters: { tumourType: 'meningioma', computeMniReport: false, skullStripped: true },
      }),
      /locked by another process/,
    );

    // Empty mask / cacheDir rejected BEFORE creating output directory.
    const untouchedOut = join(work, 'should-not-exist');
    await assert.rejects(
      analyze({ input: t1cPath, output: untouchedOut, mask: '', offline: true }),
      /mask must be a non-empty string/,
    );
    await assert.rejects(access(untouchedOut), { code: 'ENOENT' });

    // Bad gzip CRC rejected cleanly.
    const badGz = Buffer.from(gzipSync(synth.t1c));
    badGz[badGz.length - 5] ^= 0xff;
    const badGzPath = join(work, 'corrupt.nii.gz');
    await writeFile(badGzPath, badGz);
    await assert.rejects(
      analyze({
        input: badGzPath,
        mask: maskPath,
        output: join(work, 'out-corrupt'),
        offline: true,
        parameters: { computeMniReport: false, skullStripped: true },
      }),
    );
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test('bin/tumour-report.js enforces strict CLI validation per subcommand', async () => {
  const help = execFileSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
  assert.match(help, /Usage: tumour-report/);

  const cleanEnv = { ...process.env };
  delete cleanEnv.NEURODESK_TUMOUR_REPORT_MODEL_DIR;
  const selfOut = runBin(['self-check'], cleanEnv);
  assert.equal(selfOut.status, 0, selfOut.stderr);
  assert.equal(JSON.parse(selfOut.stdout.trim()).ok, true);

  // Disallowed and empty options per subcommand must fail non-zero.
  const badCases = [
    ['self-check', '--mask='],
    ['self-check', '--mask=foo.nii'],
    ['self-check', '--cache-dir='],
    ['self-check', '--no-mni'],
    ['download-models', '--mask=foo.nii'],
    ['download-models', '--cache-dir='],
    ['download-models', '--tumour-type=metastasis'],
    ['in.nii', 'out', '--mask='],
    ['in.nii', 'out', '--cache-dir='],
    ['in.nii', 'out', '--tumour-type='],
    ['in.nii', 'out', '--threads='],
    ['in.nii', 'out', '--threads=2.5'],
  ];
  for (const args of badCases) {
    const res = runBin(args, cleanEnv);
    assert.notEqual(res.status, 0, `Expected failure for args: ${args.join(' ')}`);
  }
});
