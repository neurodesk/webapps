import { renameSync } from 'node:fs';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

const reservedNames = new Set(['job-result.json', '.job-result.json.partial', 'run.json']);
const pause = () => new Promise(resolve => setTimeout(resolve, 100));

export async function completeBrowserArtifacts(contents, { outputDirectory, signal, assertHostHealthy }, execute) {
  if (typeof assertHostHealthy !== 'function') throw new Error('Browser completion requires a host health check');
  signal?.throwIfAborted();
  const output = resolve(outputDirectory);
  await mkdir(output, { recursive: true });
  if ((await readdir(output)).length) throw new Error('Output directory must be empty');
  signal?.throwIfAborted();
  const partialPath = join(output, '.job-result.json.partial');
  const reportPath = join(output, 'job-result.json');
  const session = contents.session;
  const names = new Set();
  const claimedIds = new Set();
  const active = new Set();
  const downloads = [];
  let phase = 'collecting';
  let expectation;
  let unlabelled = false;
  let failure;
  let verifiedReport;

  function assertHealthy() {
    signal?.throwIfAborted();
    if (failure) throw failure;
  }
  function rejectDownload(item, error) {
    failure ??= error;
    item.cancel();
  }
  function onDownload(_event, item, owner) {
    if (owner !== contents) return;
    const filename = basename(item.getFilename());
    if (names.has(filename)) return rejectDownload(item, new Error(`Duplicate output: ${filename}`));
    if (phase !== 'collecting' || reservedNames.has(filename) || !filename || filename === '.' || filename === '..'
        || (!unlabelled && !expectation)) return rejectDownload(item, new Error(`Unexpected output: ${filename}`));
    if (expectation?.claimed) return rejectDownload(item, new Error(`Duplicate artifact output: ${expectation.id}`));
    names.add(filename);
    const expected = expectation;
    if (expected) expected.claimed = true;
    active.add(item);
    item.once('done', (_event, state) => {
      active.delete(item);
      if (state !== 'completed') {
        failure ??= new Error(`Output download ${filename}: ${state}`);
        return;
      }
      const record = { filename, bytes: item.getReceivedBytes(), ...(expected && { role: expected.id }) };
      downloads.push(record);
      if (expected) expected.download = record;
    });
    try {
      item.setSavePath(join(output, filename));
    } catch (error) {
      rejectDownload(item, error);
    }
  }
  function assertCollecting() {
    assertHealthy();
    if (phase !== 'collecting' || expectation) throw new Error('Artifact collection is not available');
  }
  function assertComplete() {
    assertHealthy();
    if (active.size || names.size !== downloads.length || downloads.some(item => !Number.isSafeInteger(item.bytes) || item.bytes <= 0)) {
      throw new Error('Batch output validation failed');
    }
  }
  const artifacts = {
    assertHealthy,
    async download(id, trigger, observe) {
      assertCollecting();
      if (!id || claimedIds.has(id)) throw new Error(`Duplicate or missing artifact ID: ${id}`);
      claimedIds.add(id);
      const expected = { id, claimed: false };
      expectation = expected;
      try {
        await trigger();
        assertHealthy();
        while (!expected.download) {
          await observe();
          assertHealthy();
          if (!expected.download) await pause();
        }
      } finally {
        expectation = undefined;
      }
    },
    async collectUnlabelled(expectedCount, performSteps, observe) {
      assertCollecting();
      if (unlabelled) throw new Error('Artifact collection is already active');
      unlabelled = true;
      try {
        await performSteps();
        while (downloads.length < expectedCount) {
          await observe(downloads.length);
          assertHealthy();
          if (downloads.length < expectedCount) await pause();
        }
        await observe(downloads.length);
        assertComplete();
        if (downloads.length !== expectedCount) throw new Error('Batch output validation failed');
      } finally {
        unlabelled = false;
      }
    },
    async verify(validator) {
      assertCollecting();
      if (unlabelled) throw new Error('Artifact collection is still active');
      phase = 'verifying';
      assertComplete();
      verifiedReport = await validator({ output, downloads: downloads.map(item => ({ ...item })) });
      assertHealthy();
      phase = 'verified';
      return verifiedReport;
    },
  };

  session.on('will-download', onDownload);
  try {
    assertHostHealthy();
    const outcome = await execute(artifacts);
    assertComplete();
    if (phase !== 'verified' || !verifiedReport || outcome?.report !== verifiedReport) {
      throw new Error('Browser completion requires its verified report');
    }
    assertHostHealthy();
    phase = 'publishing';
    await writeFile(partialPath, `${JSON.stringify(verifiedReport, null, 2)}\n`, { signal });
    assertComplete();
    assertHostHealthy();
    signal?.throwIfAborted();
    renameSync(partialPath, reportPath);
    phase = 'committed';
    return outcome;
  } catch (error) {
    phase = 'failed';
    for (const item of active) {
      try { item.cancel(); } catch (cleanupError) { console.error('Could not cancel output download:', cleanupError); }
    }
    const cleanup = await Promise.allSettled([rm(partialPath, { force: true }), rm(reportPath, { force: true })]);
    for (const result of cleanup) {
      if (result.status === 'rejected') console.error('Could not remove completion report:', result.reason);
    }
    throw error;
  } finally {
    session.off('will-download', onDownload);
  }
}
