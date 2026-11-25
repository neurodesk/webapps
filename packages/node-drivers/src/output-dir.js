// Exclusive output-directory lock and atomic paired-file publication for Node CLIs.
// - Acquires ONE shared O_EXCL ('wx') lock file (.neurodesk-cli.lock) BEFORE processing
//   so concurrent runs of the same or different CLIs cannot collide.
// - Registers synchronous SIGINT/SIGTERM cleanup handlers while a lock is held.
// - Tracks `.partial` paths before writing so disk-full/EFBIG failures clean up cleanly.
// - Checks destinations with lstat (preserving dangling symlinks, refusing directories).
// - Rolls back already-renamed outputs (and restores backups if overwriting) on failure.
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { lstat, open, readdir, rename, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

export const LOCK_FILENAME = '.neurodesk-cli.lock';

function lstatExistsSync(filePath) {
  try {
    lstatSync(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

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

  let firstCreated = null;
  const lockName = LOCK_FILENAME;
  const lockPath = join(resolvedDir, lockName);

  let lockHandle = null;
  let lockFd = null;
  let lockOwned = false;
  let acquiringLock = false;
  let deferredSignal = null;
  let committed = false;
  let released = false;
  let signalRegistered = false;
  let activePublish = null;
  const activePartials = new Set();

  const unregisterSignals = () => {
    if (!signalRegistered) return;
    signalRegistered = false;
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  };

  function cleanupAndTerminateSync(signal) {
    unregisterSignals();
    let rollbackOk = true;

    if (activePublish) {
      const { staged, published, backups, pendingBackup, pendingRename } = activePublish;
      if (!activePublish.committed) {
        if (pendingRename && !published.includes(pendingRename)) {
          try {
            if (!lstatExistsSync(pendingRename.partial) && lstatExistsSync(pendingRename.dest)) {
              published.push(pendingRename);
            }
          } catch {
            rollbackOk = false;
          }
        }
        if (pendingBackup && !pendingBackup.item.backup) {
          try {
            if (lstatExistsSync(pendingBackup.backupPath)) {
              pendingBackup.item.backup = pendingBackup.backupPath;
              backups.push(pendingBackup.item);
            }
          } catch {
            rollbackOk = false;
          }
        }
        for (let i = published.length - 1; i >= 0; i -= 1) {
          const item = published[i];
          try {
            unlinkSync(item.dest);
          } catch (error) {
            if (error.code !== 'ENOENT') rollbackOk = false;
          }
          if (item.backup) {
            try {
              renameSync(item.backup, item.dest);
              item.backup = null;
            } catch {
              rollbackOk = false;
            }
          }
        }
        for (let i = backups.length - 1; i >= 0; i -= 1) {
          const item = backups[i];
          if (item.backup) {
            try {
              renameSync(item.backup, item.dest);
              item.backup = null;
            } catch {
              rollbackOk = false;
            }
          }
        }
        for (const item of staged) {
          try {
            rmSync(item.partial, { force: true });
          } catch {
            // Best-effort cleanup of staged partials during termination.
          }
          activePartials.delete(item.partial);
        }
      } else {
        for (const item of backups) {
          if (item.backup) {
            try {
              rmSync(item.backup, { force: true });
              item.backup = null;
            } catch {
              // Best-effort cleanup of post-commit backups.
            }
          }
        }
      }
    }

    for (const partial of activePartials) {
      try {
        rmSync(partial, { force: true });
      } catch {
        // Best-effort cleanup during termination.
      }
    }
    activePartials.clear();

    if (lockFd !== null) {
      const fd = lockFd;
      lockFd = null;
      try {
        closeSync(fd);
      } catch {
        // Ignore close errors during termination.
      }
    }
    if (lockHandle) {
      const h = lockHandle;
      lockHandle = null;
      try {
        if (typeof h.fd === 'number' && h.fd >= 0) closeSync(h.fd);
      } catch {
        // Ignore close errors during termination.
      }
    }

    // Keep the lock on disk if an interrupted publication could not roll back cleanly.
    if (lockOwned && rollbackOk) {
      lockOwned = false;
      try {
        rmSync(lockPath, { force: true });
      } catch {
        // Best-effort cleanup during termination.
      }
    }
    if (!committed && rollbackOk && firstCreated) {
      removeEmptyDirsUpToSync(resolvedDir, firstCreated);
    }
    released = true;
    process.kill(process.pid, signal);
  }

  function onSignal(signal) {
    if (acquiringLock) {
      deferredSignal = signal;
      return;
    }
    cleanupAndTerminateSync(signal);
  }

  const release = async () => {
    if (released) return;
    released = true;
    unregisterSignals();
    if (lockFd !== null) {
      const fd = lockFd;
      lockFd = null;
      try {
        closeSync(fd);
      } catch {
        // Ignore close errors during release.
      }
    }
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

  // Install signal handlers BEFORE creating directories or acquiring the lock so
  // SIGINT/SIGTERM arriving around open(O_EXCL) can never leave a stale lock behind.
  signalRegistered = true;
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    if (!existingStat) {
      firstCreated = mkdirSync(resolvedDir, { recursive: true }) ?? null;
    }

    const payload = JSON.stringify({
      pid: process.pid,
      tool,
      startedAt: new Date().toISOString(),
    });

    try {
      if (openFn === open && !writeLockMetadata) {
        // Synchronous open+write+close closes the async window between creating
        // the lock file and setting lockOwned = true.
        lockFd = openSync(lockPath, 'wx');
        lockOwned = true;
        writeFileSync(lockFd, `${payload}\n`, 'utf8');
        closeSync(lockFd);
        lockFd = null;
      } else {
        acquiringLock = true;
        try {
          lockHandle = await openFn(lockPath, 'wx');
          lockOwned = true;
        } finally {
          acquiringLock = false;
        }
        if (deferredSignal) {
          const sig = deferredSignal;
          deferredSignal = null;
          cleanupAndTerminateSync(sig);
        }
        if (writeLockMetadata) {
          await writeLockMetadata(lockHandle, payload);
        } else {
          await lockHandle.writeFile(`${payload}\n`, 'utf8');
        }
        await lockHandle.close();
        lockHandle = null;
      }
    } catch (error) {
      if (deferredSignal) {
        const sig = deferredSignal;
        deferredSignal = null;
        cleanupAndTerminateSync(sig);
      }
      if (error.code === 'EEXIST') {
        throw new Error(`Output directory is locked by another process: ${resolvedDir}`);
      }
      throw error;
    }

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
    // Roll back every renamed file and restore backups if ANY rename fails or a signal arrives.
    const published = [];
    const backups = [];
    const publishState = {
      staged,
      published,
      backups,
      pendingBackup: null,
      pendingRename: null,
      committed: false,
    };
    activePublish = publishState;
    const useSyncRename = renameFn === rename;
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
            if (useSyncRename) {
              renameSync(item.dest, backupPath);
              item.backup = backupPath;
              backups.push(item);
            } else {
              publishState.pendingBackup = { item, backupPath };
              await renameFn(item.dest, backupPath);
              item.backup = backupPath;
              backups.push(item);
              publishState.pendingBackup = null;
            }
          }
        }
        if (useSyncRename) {
          renameSync(item.partial, item.dest);
          activePartials.delete(item.partial);
          published.push(item);
        } else {
          publishState.pendingRename = item;
          await renameFn(item.partial, item.dest);
          activePartials.delete(item.partial);
          published.push(item);
          publishState.pendingRename = null;
        }
      }
      publishState.committed = true;
      committed = true;
    } catch (error) {
      publishState.pendingBackup = null;
      publishState.pendingRename = null;
      while (published.length > 0) {
        const item = published.pop();
        await unlink(item.dest).catch(() => {});
        if (item.backup) {
          await rename(item.backup, item.dest).catch(() => {});
          item.backup = null;
        }
      }
      while (backups.length > 0) {
        const item = backups.pop();
        if (item.backup) {
          await rename(item.backup, item.dest).catch(() => {});
          item.backup = null;
        }
      }
      for (const item of staged) {
        await rm(item.partial, { force: true }).catch(() => {});
        activePartials.delete(item.partial);
      }
      activePublish = null;
      throw error;
    }

    for (const item of backups) {
      if (item.backup) {
        await rm(item.backup, { force: true }).catch(() => {});
        item.backup = null;
      }
    }
    activePublish = null;

    return staged.map((item) => item.name);
  };

  return {
    dir: resolvedDir,
    lockPath,
    publish,
    release,
  };
}
