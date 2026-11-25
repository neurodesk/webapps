// Offline unit tests for the @neurodesk/totalsegmentator Node API and CLI binary.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { writeVolume } from '@neurodesk/synthsr';
import { MODEL_ASSETS, checkInstallation, defaultCacheDir, resolveThreads, segment } from '../src/node.js';

const BIN = fileURLToPath(new URL('../bin/totalsegmentator.js', import.meta.url));

describe('TotalSegmentator Node API and CLI (offline)', () => {
  it('checks ONNX Runtime CPU installation and exposes all 12 model assets', async () => {
    assert.equal(MODEL_ASSETS.length, 12);
    const prev = process.env.NEURODESK_TOTALSEGMENTATOR_MODEL_DIR;
    delete process.env.NEURODESK_TOTALSEGMENTATOR_MODEL_DIR;
    try {
      const report = await checkInstallation();
      assert.equal(report.executionProvider, 'cpu');
      assert.equal(report.node, process.version);
      assert.ok(report.onnxRuntime);
    } finally {
      if (prev !== undefined) process.env.NEURODESK_TOTALSEGMENTATOR_MODEL_DIR = prev;
    }
  });

  it('validates thread counts and resolves cache directory overrides', () => {
    assert.equal(resolveThreads(4), 4);
    assert.equal(resolveThreads('2'), 2);
    for (const bad of [0, -1, 1.5, '0', 'abc', '']) {
      assert.throws(() => resolveThreads(bad), /positive integer/);
    }
    const prev = process.env.NEURODESK_TOTALSEGMENTATOR_MODEL_DIR;
    try {
      process.env.NEURODESK_TOTALSEGMENTATOR_MODEL_DIR = '/custom/models';
      assert.equal(defaultCacheDir(), '/custom/models');
    } finally {
      if (prev === undefined) delete process.env.NEURODESK_TOTALSEGMENTATOR_MODEL_DIR;
      else process.env.NEURODESK_TOTALSEGMENTATOR_MODEL_DIR = prev;
    }
  });

  it('rejects missing args, invalid task/subset plans, non-empty output dirs, missing offline models and corrupt caches', async () => {
    const work = await mkdtemp(join(tmpdir(), 'totalseg-node-test-'));
    try {
      const scanPath = join(work, 'tiny.nii');
      const nifti = writeVolume({
        data: new Float32Array(64).fill(40),
        dims: [4, 4, 4],
        affine: [[3, 0, 0, 0], [0, 3, 0, 0], [0, 0, 3, 0], [0, 0, 0, 1]],
      });
      await writeFile(scanPath, Buffer.from(nifti));

      await assert.rejects(() => segment({ input: scanPath }), /output directory are required/);
      await assert.rejects(
        () => segment({ input: scanPath, output: join(work, 'bad-sub'), task: 'total_mr', resolution: 'full', subset: 'ribs', offline: true }),
        /Unsupported subset/,
      );

      const occupied = join(work, 'occupied');
      await writeFile(occupied, 'not-a-dir');
      await assert.rejects(() => segment({ input: scanPath, output: occupied, offline: true }), /not a directory/);

      await assert.rejects(
        () => segment({ input: scanPath, output: join(work, 'offline-out'), cacheDir: join(work, 'empty-cache'), offline: true }),
        /missing from the offline model directory/,
      );

      // Corrupt cached model must fail checksum verification even offline.
      const corruptCache = join(work, 'corrupt-cache');
      await writeFile(join(work, 'corrupt.tmp'), 'bad');
      const fs = await import('node:fs/promises');
      await fs.mkdir(corruptCache, { recursive: true });
      await writeFile(join(corruptCache, 'totalsegmentator-total-ct-3mm.onnx'), 'corrupt-bytes');
      await assert.rejects(
        () => segment({ input: scanPath, output: join(work, 'corrupt-out'), cacheDir: corruptCache, offline: true }),
        /failed checksum verification/,
      );
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  it('runs bin/totalsegmentator.js --help and self-check cleanly', () => {
    const help = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /Usage: totalsegmentator/);
    assert.match(help.stdout, /--task NAME/);

    const env = { ...process.env };
    delete env.NEURODESK_TOTALSEGMENTATOR_MODEL_DIR;
    const selfCheck = spawnSync(process.execPath, [BIN, 'self-check'], { encoding: 'utf8', env });
    assert.equal(selfCheck.status, 0, selfCheck.stderr);
    const report = JSON.parse(selfCheck.stdout);
    assert.equal(report.executionProvider, 'cpu');
  });
});
