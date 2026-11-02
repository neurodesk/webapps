import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { downloadPrior } from '../src/syn/node.js';
import { PRIOR_BASE_URL, PRIOR_SHA256 } from '../src/syn/prior.js';

const SDC = fileURLToPath(new URL('../bin/sdc.js', import.meta.url));
const sdc = (...args) => spawnSync(process.execPath, [SDC, ...args], { encoding: 'utf8' });

test('the command line downloads the prior that models/sdc.manifest.json pins', async () => {
  const manifest = JSON.parse(await readFile(new URL('../../../models/sdc.manifest.json', import.meta.url), 'utf8'));
  assert.equal(PRIOR_BASE_URL, manifest.base_url);
  assert.deepEqual(PRIOR_SHA256, Object.fromEntries(manifest.assets.map(({ filename, sha256 }) => [filename, sha256])));
});

test('offline, a missing or changed prior file is refused, never downloaded', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'sdc-prior-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'fmap_atlas.nii.gz'), 'not the atlas');
  await assert.rejects(downloadPrior({ directory, offline: true }), /fmap_atlas\.nii\.gz is missing from the prior directory/);
});

test('the command line refuses incomplete arguments before any work', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'sdc-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const dwi = join(directory, 'dwi.nii.gz');
  await writeFile(dwi, '');
  for (const [args, message] of [
    [[dwi], /Give one DWI series and a new output directory/],
    [[dwi, join(directory, 'out')], /Give the T1w of the same session with --t1w/],
    [[dwi, join(directory, 'out'), '--t1w', dwi], /No \.bval and \.bvec beside/],
    [[dwi, join(directory, 'out'), '--t1w', dwi, '--no-prior', '--prior-dir', directory], /exclude each other/],
    [['self-check', 'extra'], /self-check does not accept arguments/],
    [[dwi, join(directory, 'out'), '--cache-dir', directory], /--cache-dir only applies to download-models/],
  ]) {
    const run = sdc(...args);
    assert.equal(run.status, 1, args.join(' '));
    assert.match(run.stderr, message);
  }
  assert.match(sdc('--help').stdout, /^Usage: sdc DWI/);
});
