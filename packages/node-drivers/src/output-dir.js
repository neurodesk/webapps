// Exclusive output-directory lock and atomic paired-file publication for Node CLIs.
// - Acquires ONE shared O_EXCL ('wx') lock file (.neurodesk-cli.lock) BEFORE processing
//   so concurrent runs of the same or different CLIs cannot collide.
// - Registers synchronous SIGINT/SIGTERM cleanup handlers while a lock is held.
// - Tracks `.partial` paths before writing so disk-full/EFBIG failures clean up cleanly.
// - Checks destinations with lstat (preserving dangling symlinks, refusing directories).
// - Rolls back already-renamed outputs (and restores backups if overwriting) on failure.
import { randomUUID } from 'node:crypto';
import { rmSync, rmdirSync } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

export const LOCK_FILENAME = '.neurodesk-cli.lock';

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

function removeEmptyDirsUpToSync(leafDir, topCreatedDir) {
  if (!topCreatedDir) return;
  const stop = resolve(topCreatedDir);
  let current = resolve(leafDir);
  while (true) {
    try {
      rmdirSync(current);
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
  const lockName = LOCK_FILENAME;
  const lockPath = join(resolvedDir, lockName);

  let lockHandle = null;
  let lockOwned = false;
  let committed = false;
  let released = false;
  let signalRegistered = false;
  const activePartials = new Set();

  const unregisterSignals = () => {
    if (!signalRegistered) return;
    signalRegistered = false;
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  };

  function onSignal(signal) {
    unregisterSignals();
    for (const partial of activePartials) {
      try {
        rmSync(partial, { force: true });
      } catch {
        // Best-effort cleanup during termination.
      }
    }
    activePartials.clear();
    if (lockOwned) {
      lockOwned = false;
      try {
        rmSync(lockPath, { force: true });
      } catch {
        // Best-effort cleanup during termination.
      }
    }
    if (!committed && firstCreated) {
      removeEmptyDirsUpToSync(resolvedDir, firstCreated);
    }
    released = true;
    process.kill(process.pid, signal);
  }

  const release = async () => {
    if (released) return;
    released = true;
    unregisterSignals();
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
      signalRegistered = true;
      process.on('SIGINT', onSignal);
      process.on('SIGTERM', onSignal);
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

    // Phase 1: Track every .partial path BEFORE writing so failed/partial writes are cleaned up.
    try {
      for (const entry of entries) {
        const partial = join(resolvedDir, `.${entry.name}.${runId}.partial`);
        const item = {
          name: entry.name,
          partial,
          dest: join(resolvedDir, entry.name),
          backup: null,
        };
        staged.push(item);
        activePartials.add(partial);
        await writeFileFn(partial, entry.data, { flag: 'wx' });
      }
    } catch (error) {
      for (const item of staged) {
        await rm(item.partial, { force: true }).catch(() => {});
        activePartials.delete(item.partial);
      }
      throw error;
    }

    // Phase 2: Inspect every destination via lstat (never following symlinks), refuse directories,
    // back up existing files/symlinks when overwrite=true, and rename all staged files.
    // Roll back every renamed file and restore backups if ANY rename fails.
    const published = [];
    const backups = [];
    try {
      for (const item of staged) {
        const destStat = await lstat(item.dest).catch((error) => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
        if (destStat?.isDirectory()) {
          throw new Error(`Refusing to overwrite directory: ${item.dest}`);
        }
        if (!overwrite && destStat) {
          throw new Error(`Refusing to overwrite existing output: ${item.dest}`);
        }
      }

      for (const item of staged) {
        if (overwrite) {
          const destStat = await lstat(item.dest).catch((error) => {
            if (error.code === 'ENOENT') return null;
            throw error;
          });
          if (destStat?.isDirectory()) {
            throw new Error(`Refusing to overwrite directory: ${item.dest}`);
          }
          if (destStat) {
            const backupPath = join(resolvedDir, `.${basename(item.dest)}.${runId}.backup`);
            await renameFn(item.dest, backupPath);
            item.backup = backupPath;
            backups.push(item);
          }
        }
        await renameFn(item.partial, item.dest);
        activePartials.delete(item.partial);
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
        activePartials.delete(item.partial);
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
