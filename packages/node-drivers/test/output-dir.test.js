import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { claimOutputDir } from '../src/output-dir.js';

test('claimOutputDir acquires an exclusive O_EXCL lock and rejects concurrent claims', async () => {
  const root = await mkdtemp(join(tmpdir(), 'output-dir-lock-'));
  try {
    const outDir = join(root, 'results');
    const first = await claimOutputDir(outDir, { tool: 'demo' });
    try {
      await assert.rejects(
        claimOutputDir(outDir, { tool: 'demo' }),
        /Output directory is locked by another process/,
      );
    } finally {
      await first.release();
    }
    // After release without publication, the newly created directory and lock are removed.
    await assert.rejects(access(outDir), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('claimOutputDir cleans up lock and newly created directory on metadata write or readdir error', async () => {
  const root = await mkdtemp(join(tmpdir(), 'output-dir-cleanup-'));
  try {
    const dirA = join(root, 'nested', 'enospc');
    await assert.rejects(
      claimOutputDir(dirA, {
        tool: 'demo',
        writeLockMetadata: async () => {
          const err = new Error('No space left on device');
          err.code = 'ENOSPC';
          throw err;
        },
      }),
      /No space left on device/,
    );
    await assert.rejects(access(join(root, 'nested')), { code: 'ENOENT' });

    const dirB = join(root, 'readdir-fail');
    await assert.rejects(
      claimOutputDir(dirB, {
        tool: 'demo',
        readdirFn: async () => {
          throw new Error('simulated readdir failure');
        },
      }),
      /simulated readdir failure/,
    );
    await assert.rejects(access(dirB), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('publish stages all files and rolls back already-renamed outputs on partial rename failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'output-dir-rollback-'));
  try {
    const outDir = join(root, 'out');
    const claim = await claimOutputDir(outDir, { tool: 'demo' });
    let calls = 0;
    try {
      await assert.rejects(
        claim.publish(
          [
            { name: 'a.nii', data: Buffer.from('AAA') },
            { name: 'b.nii', data: Buffer.from('BBB') },
          ],
          {
            renameFn: async (src, dst) => {
              calls += 1;
              if (calls === 2) throw new Error('simulated rename failure on second file');
              return rename(src, dst);
            },
          },
        ),
        /simulated rename failure/,
      );
    } finally {
      await claim.release();
    }
    // Rolled back and cleaned up completely.
    await assert.rejects(access(outDir), { code: 'ENOENT' });

    // Overwrite mode restores previous files if a later rename fails.
    const existingDir = await mkdtemp(join(root, 'existing-'));
    await writeFile(join(existingDir, 'a.nii'), 'OLD_A');
    await writeFile(join(existingDir, 'b.nii'), 'OLD_B');
    const overwriteClaim = await claimOutputDir(existingDir, { tool: 'demo', overwrite: true });
    let renameCount = 0;
    try {
      await assert.rejects(
        overwriteClaim.publish(
          [
            { name: 'a.nii', data: Buffer.from('NEW_A') },
            { name: 'b.nii', data: Buffer.from('NEW_B') },
          ],
          {
            renameFn: async (src, dst) => {
              renameCount += 1;
              // Call 1: backup a.nii, Call 2: publish a.nii, Call 3: backup b.nii, Call 4: fail publish b.nii
              if (renameCount === 4) throw new Error('simulated overwrite rename failure');
              return rename(src, dst);
            },
          },
        ),
        /simulated overwrite rename failure/,
      );
    } finally {
      await overwriteClaim.release();
    }
    assert.equal(await readFile(join(existingDir, 'a.nii'), 'utf8'), 'OLD_A');
    assert.equal(await readFile(join(existingDir, 'b.nii'), 'utf8'), 'OLD_B');
    assert.deepEqual((await readdir(existingDir)).sort(), ['a.nii', 'b.nii']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
