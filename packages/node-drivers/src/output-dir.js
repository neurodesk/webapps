// Exclusive output-directory lock and atomic paired-file publication for Node CLIs.
// - Acquires an O_EXCL ('wx') lock file BEFORE processing so concurrent runs cannot collide.
// - Cleans up the lock file and any newly created empty directories on every error path.
// - Stages ALL output files to unique `.partial` paths before renaming ANY of them.
// - Rolls back already-renamed outputs (and restores backups if overwriting) on rename failure.
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readdir, rename, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

async function removeEmptyDirsUpTo(leafDir, topCreatedDir) {
  if (!topCreatedDir) return;
  const stop = resolve(topCreatedDir);
  let current = resolve(leafDir);
  while (true) {
    try {
      await rmdir(current);
    } catch {
      break;
    }
    if (current === stop) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function validateEntryName(name) {
  if (typeof name !== 'string' || !name.trim()) {
    throw new Error('Output filename must be a non-empty string.');
  }
  if (name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
    throw new Error(`Invalid output filename: ${name}`);
  }
}

export async function claimOutputDir(
  outputDir,
  {
    overwrite = false,
    tool = 'neurodesk',
    openFn = open,
    readdirFn = readdir,
    writeLockMetadata = null,
  } = {},
) {
  if (typeof outputDir !== 'string' || !outputDir.trim()) {
    throw new Error('Output directory must be a non-empty path.');
  }
  const resolvedDir = resolve(outputDir);
  const existingStat = await lstat(resolvedDir).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (existingStat && !existingStat.isDirectory()) {
    throw new Error(`Output path exists and is not a directory: ${outputDir}`);
  }

  const firstCreated = existingStat ? null : await mkdir(resolvedDir, { recursive: true });
  const lockName = `.${tool}.lock`;
  const lockPath = join(resolvedDir, lockName);

  let lockHandle = null;
  let lockOwned = false;
  let committed = false;
  let released = false;

  const release = async () => {
    if (released) return;
    released = true;
    if (lockHandle) {
      const h = lockHandle;
      lockHandle = null;
      await h.close().catch(() => {});
    }
    if (lockOwned) {
      lockOwned = false;
      await unlink(lockPath).catch(() => {});
    }
    if (!committed && firstCreated) {
      await removeEmptyDirsUpTo(resolvedDir, firstCreated);
    }
  };

  try {
    try {
      lockHandle = await openFn(lockPath, 'wx');
      lockOwned = true;
    } catch (error) {
      if (error.code === 'EEXIST') {
        throw new Error(`Output directory is locked by another process: ${resolvedDir}`);
      }
      throw error;
    }

    const payload = JSON.stringify({
      pid: process.pid,
      tool,
      startedAt: new Date().toISOString(),
    });
    if (writeLockMetadata) {
      await writeLockMetadata(lockHandle, payload);
    } else {
      await lockHandle.writeFile(`${payload}\n`, 'utf8');
    }
    await lockHandle.close();
    lockHandle = null;

    if (!overwrite) {
      const entries = await readdirFn(resolvedDir);
      const others = entries.filter((name) => name !== lockName);
      if (others.length > 0) {
        throw new Error(`Output directory is not empty: ${outputDir} (pass --overwrite to allow)`);
      }
    }
  } catch (error) {
    await release();
    throw error;
  }

  const publish = async (entries, { renameFn = rename, writeFileFn = writeFile } = {}) => {
    if (!lockOwned || released) {
      throw new Error('Cannot publish outputs after the output directory lock was released.');
    }
    const seenNames = new Set();
    for (const entry of entries) {
      validateEntryName(entry.name);
      if (seenNames.has(entry.name)) {
        throw new Error(`Duplicate output filename: ${entry.name}`);
      }
      seenNames.add(entry.name);
    }

    const runId = randomUUID();
    const staged = [];

    // Phase 1: Stage EVERY output file completely to a unique .partial path before any rename.
    try {
      for (const entry of entries) {
        const partial = join(resolvedDir, `.${entry.name}.${runId}.partial`);
        await writeFileFn(partial, entry.data, { flag: 'wx' });
        staged.push({
          name: entry.name,
          partial,
          dest: join(resolvedDir, entry.name),
          backup: null,
        });
      }
    } catch (error) {
      for (const item of staged) {
        await rm(item.partial, { force: true }).catch(() => {});
      }
      throw error;
    }

    // Phase 2: Move existing files aside (when overwrite=true) and rename all staged files.
    // Roll back every renamed file and restore backups if ANY rename fails.
    const published = [];
    const backups = [];
    try {
      for (const item of staged) {
        if (overwrite) {
          const destStat = await lstat(item.dest).catch((error) => {
            if (error.code === 'ENOENT') return null;
            throw error;
          });
          if (destStat) {
            const backupPath = join(resolvedDir, `.${basename(item.dest)}.${runId}.backup`);
            await renameFn(item.dest, backupPath);
            item.backup = backupPath;
            backups.push(item);
          }
        }
        await renameFn(item.partial, item.dest);
        published.push(item);
      }
      committed = true;
    } catch (error) {
      for (let i = published.length - 1; i >= 0; i -= 1) {
        const item = published[i];
        await unlink(item.dest).catch(() => {});
        if (item.backup) {
          await rename(item.backup, item.dest).catch(() => {});
          item.backup = null;
        }
      }
      for (let i = backups.length - 1; i >= 0; i -= 1) {
        const item = backups[i];
        if (item.backup) {
          await rename(item.backup, item.dest).catch(() => {});
          item.backup = null;
        }
      }
      for (const item of staged) {
        await rm(item.partial, { force: true }).catch(() => {});
      }
      throw error;
    }

    for (const item of backups) {
      if (item.backup) {
        await rm(item.backup, { force: true }).catch(() => {});
      }
    }

    return staged.map((item) => item.name);
  };

  return {
    dir: resolvedDir,
    lockPath,
    publish,
    release,
  };
}
