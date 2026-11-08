import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { packageComputeServer, checkFrontend } from '../scripts/package-compute-server.mjs';

async function fixture() {
  const directory = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'compute-distribution-'));
  const frontend = join(directory, 'frontend');
  await mkdir(join(frontend, 'assets'), { recursive: true });
  await writeFile(join(frontend, 'index.html'), '<script src="/nesvor/assets/app.js"></script><script src="./app-shell.js" data-neurodesk-app-shell data-ga4-measurement-id="test"></script>');
  await writeFile(join(frontend, 'assets/app.js'), 'import "./dependency.js";');
  await writeFile(join(frontend, 'assets/dependency.js'), 'export const ready = true;');
  await writeFile(join(frontend, 'app-shell.js'), 'export {};');
  await writeFile(join(frontend, 'standalone.json'), JSON.stringify({ apps: { nesvor: { computeServer: { download: { sha256: 'obsolete' } } } } }));
  const binary = join(directory, 'binary');
  await writeFile(binary, '#!/bin/sh\nexit 0\n');
  const out = join(directory, 'out');
  await mkdir(out);
  return { directory, frontend, binary, out };
}

test('archive contains frontend at its production base and honest runtime manifest', async () => {
  const fixtureData = await fixture();
  try {
    const metadata = await packageComputeServer({ ...fixtureData, version: '0.1.20260921' });
    const archive = join(fixtureData.out, metadata.archive);
    const bytes = await readFile(archive);
    assert.equal(metadata.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(metadata.bytes, bytes.length);
    const extract = join(fixtureData.directory, 'extracted');
    await mkdir(extract);
    const result = spawnSync('tar', ['-xzf', archive, '-C', extract], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const bundle = join(extract, 'neurodesk-compute-0.1.20260921-linux-x64');
    await checkFrontend(join(bundle, 'www'));
    assert.match(await readFile(join(bundle, 'www/index.html'), 'utf8'), /url=\/nesvor\//);
    assert.doesNotMatch(await readFile(join(bundle, 'www/nesvor/index.html'), 'utf8'), /data-ga4-measurement-id/);
    const catalog = JSON.parse(await readFile(join(bundle, 'www/nesvor/standalone.json'), 'utf8'));
    assert.equal(catalog.apps.nesvor.computeServer, undefined);
    const runtime = JSON.parse(await readFile(join(bundle, 'runtime.json'), 'utf8'));
    assert.equal(runtime.scientificRuntimeBundled, false);
    assert.match(runtime.image, /@sha256:[a-f0-9]{64}$/);
    assert.ok((await stat(join(bundle, 'start.sh'))).mode & 0o100);
    assert.match(await readFile(join(bundle, 'start.sh'), 'utf8'), /--www/);
  } finally { await rm(fixtureData.directory, { recursive: true, force: true }); }
});

test('packaging fails when a production asset or module dependency is missing', async () => {
  const fixtureData = await fixture();
  try {
    await rm(join(fixtureData.frontend, 'assets/dependency.js'));
    await assert.rejects(packageComputeServer({ ...fixtureData, version: '0.1.20260921' }), /Missing packaged frontend dependencies/);
  } finally { await rm(fixtureData.directory, { recursive: true, force: true }); }
});

test('archive serves the cryo-em app marked as the server’s own page, keeping its cluster setup', async () => {
  const fixtureData = await fixture();
  try {
    const cryoEm = join(fixtureData.directory, 'cryo-em');
    await mkdir(join(cryoEm, 'assets'), { recursive: true });
    await writeFile(join(cryoEm, 'index.html'), '<html><head><title>Cryo-EM</title></head><script src="/cryo-em/assets/app.js"></script><script src="./app-shell.js" data-neurodesk-app-shell data-ga4-measurement-id="test"></script></html>');
    await writeFile(join(cryoEm, 'assets/app.js'), 'export {};');
    await writeFile(join(cryoEm, 'app-shell.js'), 'export {};');
    await writeFile(join(cryoEm, 'standalone.json'), JSON.stringify({ apps: { 'cryo-em': { computeServer: { runner: 'slurm', download: { sha256: 'obsolete' } } } } }));
    const metadata = await packageComputeServer({ ...fixtureData, cryoEmFrontend: cryoEm, version: '0.1.20260921' });
    const extract = join(fixtureData.directory, 'extracted');
    await mkdir(extract);
    assert.equal(spawnSync('tar', ['-xzf', join(fixtureData.out, metadata.archive), '-C', extract]).status, 0);
    const bundle = join(extract, 'neurodesk-compute-0.1.20260921-linux-x64');
    await checkFrontend(join(bundle, 'www'));
    const index = await readFile(join(bundle, 'www/cryo-em/index.html'), 'utf8');
    assert.match(index, /<meta name="neurodesk-compute" content="same-origin" \/>/);
    assert.doesNotMatch(index, /data-ga4-measurement-id/);
    assert.match(await readFile(join(bundle, 'www/index.html'), 'utf8'), /href="\/cryo-em\/"/);
    const catalog = JSON.parse(await readFile(join(bundle, 'www/cryo-em/standalone.json'), 'utf8'));
    assert.deepEqual(catalog.apps['cryo-em'].computeServer, { runner: 'slurm' });
  } finally { await rm(fixtureData.directory, { recursive: true, force: true }); }
});
