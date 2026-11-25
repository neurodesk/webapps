import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { access, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { LOCK_FILENAME, claimOutputDir } from '../src/output-dir.js';

const OUTPUT_DIR_MODULE_URL = new URL('../src/output-dir.js', import.meta.url).href;

test('claimOutputDir acquires a shared O_EXCL lock and rejects concurrent claims across CLIs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'output-dir-lock-'));
  try {
    const outDir = join(root, 'results');
    const first = await claimOutputDir(outDir, { tool: 'brainchomp', overwrite: true });
    try {
      assert.equal(first.lockPath, join(outDir, LOCK_FILENAME));
      await assert.rejects(
        claimOutputDir(outDir, { tool: 'brainchomp', overwrite: true }),
        /Output directory is locked by another process/,
      );
      await assert.rejects(
        claimOutputDir(outDir, { tool: 'brainchop', overwrite: true }),
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

test('publish cleans up .partial files on failed writeFile (e.g. EFBIG/ENOSPC)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'output-dir-partial-fail-'));
  try {
    const outDir = await mkdtemp(join(root, 'existing-'));
    const claim = await claimOutputDir(outDir, { tool: 'demo' });
    let writes = 0;
    try {
      await assert.rejects(
        claim.publish(
          [
            { name: 'a.nii', data: Buffer.from('AAA') },
            { name: 'b.nii', data: Buffer.from('BBB') },
          ],
          {
            writeFileFn: async (partialPath, data, opts) => {
              writes += 1;
              if (writes === 2) {
                // Simulate a truncated partial file written before EFBIG/ENOSPC.
                await writeFile(partialPath, Buffer.from('PARTIAL'), opts);
                const err = new Error('File too large');
                err.code = 'EFBIG';
                throw err;
              }
              return writeFile(partialPath, data, opts);
            },
          },
        ),
        /File too large/,
      );
      // No .partial leftovers remain even before release().
      assert.deepEqual(await readdir(outDir), [LOCK_FILENAME]);
    } finally {
      await claim.release();
    }
    assert.deepEqual(await readdir(outDir), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('claimOutputDir cleans up lock and newly created directory on SIGINT', async () => {
  const root = await mkdtemp(join(tmpdir(), 'output-dir-sigint-'));
  try {
    const outDir = join(root, 'nested', 'sigint-out');
    const script = `
      import { claimOutputDir } from ${JSON.stringify(OUTPUT_DIR_MODULE_URL)};
      await claimOutputDir(${JSON.stringify(outDir)}, { tool: 'brainchomp' });
      process.stdout.write('LOCKED\\n');
      setInterval(() => {}, 10_000);
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const result = await new Promise((resolvePromise, rejectPromise) => {
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString('utf8');
        if (stdout.includes('LOCKED')) {
          child.kill('SIGINT');
        }
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString('utf8');
      });
      child.on('error', rejectPromise);
      child.on('exit', (code, signal) => resolvePromise({ code, signal, stderr }));
    });
    assert.equal(result.signal, 'SIGINT', `expected SIGINT termination, got code=${result.code} stderr=${result.stderr}`);
    await assert.rejects(access(join(outDir, LOCK_FILENAME)), { code: 'ENOENT' });
    await assert.rejects(access(join(root, 'nested')), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('publish refuses to overwrite a directory and preserves dangling symlinks on rollback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'output-dir-guard-'));
  try {
    // 1. Refuse overwriting an existing directory even when overwrite=true.
    const dirWithSubdir = await mkdtemp(join(root, 'with-dir-'));
    const collidingDir = join(dirWithSubdir, 'mask.nii');
    await mkdir(collidingDir);
    await writeFile(join(collidingDir, 'keep.txt'), 'KEEP');
    const claimA = await claimOutputDir(dirWithSubdir, { tool: 'demo', overwrite: true });
    try {
      await assert.rejects(
        claimA.publish([
          { name: 'brain.nii', data: Buffer.from('BRAIN') },
          { name: 'mask.nii', data: Buffer.from('MASK') },
        ]),
        /Refusing to overwrite directory/,
      );
    } finally {
      await claimA.release();
    }
    assert.equal((await lstat(collidingDir)).isDirectory(), true);
    assert.equal(await readFile(join(collidingDir, 'keep.txt'), 'utf8'), 'KEEP');
    assert.deepEqual(await readdir(dirWithSubdir), ['mask.nii']);

    // 2. Dangling symlink at destination is detected via lstat and preserved on mid-commit rollback.
    const dirWithSymlink = await mkdtemp(join(root, 'with-symlink-'));
    const danglingTarget = join(root, 'does-not-exist-target.nii');
    const symlinkPath = join(dirWithSymlink, 'a.nii');
    await symlink(danglingTarget, symlinkPath);
    await writeFile(join(dirWithSymlink, 'b.nii'), 'OLD_B');
    const claimB = await claimOutputDir(dirWithSymlink, { tool: 'demo', overwrite: true });
    let renameCount = 0;
    try {
      await assert.rejects(
        claimB.publish(
          [
            { name: 'a.nii', data: Buffer.from('NEW_A') },
            { name: 'b.nii', data: Buffer.from('NEW_B') },
          ],
          {
            renameFn: async (src, dst) => {
              renameCount += 1;
              // 1: backup dangling symlink a.nii, 2: publish a.nii, 3: backup b.nii, 4: fail publish b.nii
              if (renameCount === 4) throw new Error('simulated mid-commit rename failure');
              return rename(src, dst);
            },
          },
        ),
        /simulated mid-commit rename failure/,
      );
    } finally {
      await claimB.release();
    }
    assert.equal((await lstat(symlinkPath)).isSymbolicLink(), true);
    assert.equal(await readlink(symlinkPath), danglingTarget);
    assert.equal(await readFile(join(dirWithSymlink, 'b.nii'), 'utf8'), 'OLD_B');
    assert.deepEqual((await readdir(dirWithSymlink)).sort(), ['a.nii', 'b.nii']);
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

test('SIGTERM during lock acquisition cleans up .neurodesk-cli.lock and created directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'output-dir-sigterm-lock-'));
  try {
    const outDir = join(root, 'nested', 'sigterm-out');
    const script = `
      import { open } from 'node:fs/promises';
      import { claimOutputDir } from ${JSON.stringify(OUTPUT_DIR_MODULE_URL)};
      await claimOutputDir(${JSON.stringify(outDir)}, {
        tool: 'brainchomp',
        openFn: async (lockPath, flags) => {
          const handle = await open(lockPath, flags);
          process.kill(process.pid, 'SIGTERM');
          await new Promise((r) => setTimeout(r, 50));
          return handle;
        },
      });
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const result = await new Promise((resolvePromise, rejectPromise) => {
      let stderr = '';
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString('utf8');
      });
      child.on('error', rejectPromise);
      child.on('exit', (code, signal) => resolvePromise({ code, signal, stderr }));
    });
    assert.equal(result.signal, 'SIGTERM', `expected SIGTERM, got code=${result.code} stderr=${result.stderr}`);
    await assert.rejects(access(join(outDir, LOCK_FILENAME)), { code: 'ENOENT' });
    await assert.rejects(access(join(root, 'nested')), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('SIGINT mid-overwrite publication restores backups, cleans partials, and removes lock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'output-dir-sigint-overwrite-'));
  try {
    for (const interruptStep of [1, 2]) {
      const outDir = join(root, `existing-step-${interruptStep}`);
      await mkdir(outDir);
      await writeFile(join(outDir, 'report.json'), 'ORIGINAL_REPORT');
      await writeFile(join(outDir, 'mask.nii'), 'ORIGINAL_MASK');
      const script = `
        import { rename } from 'node:fs/promises';
        import { claimOutputDir } from ${JSON.stringify(OUTPUT_DIR_MODULE_URL)};
        const claim = await claimOutputDir(${JSON.stringify(outDir)}, { tool: 'tumour-report', overwrite: true });
        let step = 0;
        await claim.publish(
          [
            { name: 'report.json', data: Buffer.from('NEW_REPORT') },
            { name: 'mask.nii', data: Buffer.from('NEW_MASK') },
          ],
          {
            renameFn: async (src, dst) => {
              step += 1;
              await rename(src, dst);
              // step 1: after backing up report.json; step 2: after publishing report.json
              if (step === ${interruptStep}) {
                process.kill(process.pid, 'SIGINT');
                await new Promise((r) => setTimeout(r, 10_000));
              }
            },
          },
        );
      `;
      const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const result = await new Promise((resolvePromise, rejectPromise) => {
        let stderr = '';
        child.stderr.on('data', (chunk) => {
          stderr += chunk.toString('utf8');
        });
        child.on('error', rejectPromise);
        child.on('exit', (code, signal) => resolvePromise({ code, signal, stderr }));
      });
      assert.equal(result.signal, 'SIGINT', `step ${interruptStep}: expected SIGINT, got code=${result.code} stderr=${result.stderr}`);
      assert.equal(await readFile(join(outDir, 'report.json'), 'utf8'), 'ORIGINAL_REPORT');
      assert.equal(await readFile(join(outDir, 'mask.nii'), 'utf8'), 'ORIGINAL_MASK');
      assert.deepEqual((await readdir(outDir)).sort(), ['mask.nii', 'report.json']);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('non-overwrite ENOTSUP link fallback refuses destination created after lstat without clobbering', async () => {
  const root = await mkdtemp(join(tmpdir(), 'output-dir-enotsup-'));
  try {
    const outDir = await mkdtemp(join(root, 'existing-'));
    const claim = await claimOutputDir(outDir, { tool: 'demo', overwrite: false });
    let linkCalled = false;
    try {
      await assert.rejects(
        claim.publish(
          [{ name: 'a.nii', data: Buffer.from('NEW_A') }],
          {
            linkFn: (_src, dest) => {
              linkCalled = true;
              // Simulate a concurrent process creating dest AFTER Phase 2's lstat
              // check, on a filesystem where hard links are unsupported (ENOTSUP).
              writeFileSync(dest, 'INDEPENDENT_CONTENT');
              throw Object.assign(new Error('operation not supported'), { code: 'ENOTSUP' });
            },
          },
        ),
        /Refusing to overwrite existing output/,
      );
      assert.equal(linkCalled, true, 'expected ENOTSUP link fallback to be exercised');
    } finally {
      await claim.release();
    }
    assert.equal(await readFile(join(outDir, 'a.nii'), 'utf8'), 'INDEPENDENT_CONTENT');
    assert.deepEqual(await readdir(outDir), ['a.nii']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('SIGTERM during failure-triggered rollback restores backups before releasing lock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'output-dir-sigterm-rollback-'));
  try {
    const outDir = join(root, 'existing');
    await mkdir(outDir);
    await writeFile(join(outDir, 'report.json'), 'ORIGINAL_REPORT');
    await writeFile(join(outDir, 'mask.nii'), 'ORIGINAL_MASK');
    const script = `
      import { rename } from 'node:fs/promises';
      import { claimOutputDir } from ${JSON.stringify(OUTPUT_DIR_MODULE_URL)};
      const claim = await claimOutputDir(${JSON.stringify(outDir)}, { tool: 'tumour-report', overwrite: true });
      let step = 0;
      try {
        await claim.publish(
          [
            { name: 'report.json', data: Buffer.from('NEW_REPORT') },
            { name: 'mask.nii', data: Buffer.from('NEW_MASK') },
          ],
          {
            renameFn: async (src, dst) => {
              step += 1;
              if (step === 3) {
                // Fail right after report.json was backed up & published, while queuing SIGTERM
                process.kill(process.pid, 'SIGTERM');
                throw new Error('simulated failure on mask backup');
              }
              return rename(src, dst);
            },
          },
        );
      } finally {
        await claim.release();
        await new Promise((r) => setTimeout(r, 500));
      }
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const result = await new Promise((resolvePromise, rejectPromise) => {
      let stderr = '';
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString('utf8');
      });
      child.on('error', rejectPromise);
      child.on('exit', (code, signal) => resolvePromise({ code, signal, stderr }));
    });
    assert.ok(result.signal === 'SIGTERM' || result.code !== 0, `expected failure/SIGTERM, got ${JSON.stringify(result)}`);
    assert.equal(await readFile(join(outDir, 'report.json'), 'utf8'), 'ORIGINAL_REPORT');
    assert.equal(await readFile(join(outDir, 'mask.nii'), 'utf8'), 'ORIGINAL_MASK');
    assert.deepEqual((await readdir(outDir)).sort(), ['mask.nii', 'report.json']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
