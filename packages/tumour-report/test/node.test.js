import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { readVolume, writeVolume } from '@neurodesk/synthsr';
import { analyze, checkInstallation, defaultCacheDir, downloadModels, validateParameters } from '../src/node.js';

const BIN = fileURLToPath(new URL('../bin/tumour-report.js', import.meta.url));

function makeSyntheticVolume(dims = [12, 12, 12]) {
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
    [1, 0, 0, -6],
    [0, 1, 0, -6],
    [0, 0, 1, -6],
    [0, 0, 0, 1],
  ];
  return {
    t1c: Buffer.from(writeVolume({ data, dims, affine }, 'synthetic T1c')),
    mask: Buffer.from(writeVolume({ data: mask, dims, affine }, 'synthetic tumour mask')),
    dims,
    affine,
  };
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
  assert.throws(() => validateParameters({ tumourType: 'unknown' }), /tumourType/);
  assert.throws(() => validateParameters({ computeMniReport: 'yes' }), /boolean/);
});

test('defaultCacheDir honors NEURODESK_TUMOUR_REPORT_MODEL_DIR', () => {
  const prev = process.env.NEURODESK_TUMOUR_REPORT_MODEL_DIR;
  try {
    process.env.NEURODESK_TUMOUR_REPORT_MODEL_DIR = '/custom/tumour-models';
    assert.equal(defaultCacheDir(), '/custom/tumour-models');
  } finally {
    if (prev === undefined) delete process.env.NEURODESK_TUMOUR_REPORT_MODEL_DIR;
    else process.env.NEURODESK_TUMOUR_REPORT_MODEL_DIR = prev;
  }
});

test('checkInstallation verifies ONNX Runtime CPU and Greedy WASM offline', async () => {
  const info = await checkInstallation();
  assert.equal(info.ok, true);
  assert.equal(info.executable, process.execPath);
  assert.equal(info.node, process.version);
  assert.equal(info.executionProvider, 'cpu');
  assert.equal(info.greedy, 'wasm-single');
  assert.equal(typeof info.onnxRuntime, 'string');
  assert.equal(info.assets, 10);
});

test('downloadModels refuses missing assets in offline mode', async () => {
  const emptyDir = await mkdtemp(join(tmpdir(), 'tumour-offline-'));
  try {
    await assert.rejects(
      downloadModels({ cacheDir: emptyDir, offline: true }),
      /missing from offline model directory/,
    );
  } finally {
    await rm(emptyDir, { recursive: true, force: true });
  }
});

test('analyze characterizes a supplied binary mask offline without network or models', async () => {
  const work = await mkdtemp(join(tmpdir(), 'tumour-supplied-'));
  try {
    const synth = makeSyntheticVolume();
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
    assert.ok(summary.files.includes('sub-01_T1c_tumour_mask.nii'));
    assert.ok(summary.files.includes('sub-01_T1c_brain_mask.nii'));
    assert.ok(summary.files.includes('sub-01_T1c_report.json'));
    assert.ok(summary.files.includes('sub-01_T1c_lesions.tsv'));
    assert.ok(summary.files.includes('sub-01_T1c_rads_summary.tsv'));

    const writtenMask = readVolume((await readFile(join(outDir, 'sub-01_T1c_tumour_mask.nii'))).buffer);
    assert.deepEqual(writtenMask.dims, synth.dims);

    // Refuses non-empty output directory without --overwrite
    await assert.rejects(
      analyze({
        input: t1cPath,
        mask: maskPath,
        output: outDir,
        offline: true,
        parameters: { computeMniReport: false, skullStripped: true },
      }),
      /Output directory is not empty/,
    );
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test('bin/tumour-report.js supports --help and self-check', () => {
  const help = execFileSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
  assert.match(help, /Usage: tumour-report/);
  assert.match(help, /download-models/);
  assert.match(help, /self-check/);

  const selfOut = execFileSync(process.execPath, [BIN, 'self-check'], { encoding: 'utf8' });
  const parsed = JSON.parse(selfOut.trim());
  assert.equal(parsed.ok, true);
  assert.equal(parsed.executable, process.execPath);
  assert.equal(parsed.node, process.version);
});
