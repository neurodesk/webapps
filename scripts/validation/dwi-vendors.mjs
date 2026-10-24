import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parseArgs } from 'node:util';
import { gzipSync } from 'node:zlib';
import { chromium } from '@playwright/test';
import { fileHash, inventoryFiles } from '../../packages/desktop/src/bundle.js';
import { inspectScientificImage } from '../lib/scientific-output-checks.mjs';
import { serveSite } from '../../test-utils/serve-site.mjs';

const root = resolve(import.meta.dirname, '../..');
const sources = JSON.parse(await readFile(join(root, 'validation/dwi-vendors/sources.json')));
const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  dir: { type: 'string' }, case: { type: 'string' }, app: { type: 'string' }, mask: { type: 'string' }, slab: { type: 'boolean' }, cores: { type: 'string', default: '3' },
} });
assert.ok(values.dir, 'Use --dir with a storage-volume directory for inputs and outputs');
const directory = resolve(values.dir);
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const cores = Number(values.cores);
assert.ok(Number.isInteger(cores) && cores > 0, '--cores must be a positive integer');
let selected = sources.cases.filter(row => !values.case || row.id === values.case);
assert.ok(selected.length, `Unknown vendor case: ${values.case}`);
if (values.slab) {
  assert.ok(!['acquire', 'prepare-mask'].includes(positionals[0]), 'Acquire and prepare masks from the original full-volume inputs');
  selected = await Promise.all(selected.map(entry => readFile(join(directory, entry.id, 'slab/manifest.json')).then(JSON.parse)));
}

async function verified(path, file) {
  return await stat(path).then(async details => details.size === file.bytes && await fileHash(path) === file.sha256, () => false);
}

if (positionals[0] === 'acquire') {
  for (const entry of selected) {
    const destination = join(directory, entry.id);
    await mkdir(destination, { recursive: true });
    for (const file of Object.values(entry.files)) {
      const path = join(destination, file.name);
      if (await verified(path, file)) continue;
      const response = await fetch(file.url, { signal: AbortSignal.timeout(600000) });
      assert.ok(response.ok && response.body, `${file.url}: HTTP ${response.status}`);
      await pipeline(Readable.fromWeb(response.body), createWriteStream(`${path}.partial`));
      assert.ok(await verified(`${path}.partial`, file), `Input checksum or size mismatch: ${file.name}`);
      await rename(`${path}.partial`, path);
    }
    console.log(`${entry.id}: every input matches its pinned size and SHA-256`);
  }
} else if (positionals[0] === 'prepare-mask') {
  for (const entry of selected) await prepareMask(entry);
} else if (positionals[0] === 'run-cli') {
  assert.ok(['noddi', 'degibbs'].includes(values.app), 'Only noddi and degibbs have command-line entry points');
  for (const entry of selected) await runCli(entry);
} else {
  assert.equal(positionals[0] ?? 'run', 'run');
  assert.ok(['noddi', 'degibbs', 'dwidenoise', 'n4'].includes(values.app), 'Choose --app noddi, degibbs, dwidenoise or n4');
  for (const entry of selected) await run(entry);
}

async function selectedMask(entry) {
  if (values.mask) return resolve(values.mask);
  if (!entry.mask) return undefined;
  const path = join(directory, entry.id, entry.mask.name);
  assert.ok(await verified(path, entry.mask), 'The cropped mask matches its recorded checksum');
  return path;
}

async function prepareMask(entry) {
  const [{ readDwi, MASK_OPTIONS }, { loadNoddi }, { loadMindgrabCpu }, nifti, { maskName, bidsStem }] = await Promise.all([
    import('../../packages/noddi/src/node.js'), import('../../packages/noddi/src/wasm.js'),
    import('../../packages/node-drivers/src/mindgrab.js'), import('../../packages/components/src/file-io/NiftiUtils.js'),
    import('../../packages/noddi/src/pipeline.js'),
  ]);
  const paths = Object.fromEntries(Object.entries(entry.files).map(([role, file]) => [role, join(directory, entry.id, file.name)]));
  for (const [role, file] of Object.entries(entry.files)) assert.ok(await verified(paths[role], file), `Input checksum: ${role}`);
  const api = await loadNoddi(await readFile(join(root, 'packages/noddi/src/noddi.wasm')));
  const input = await readDwi({ dwi: paths.image, bval: paths.bval, bvec: paths.bvec, api });
  const header = nifti.extractNiftiHeader(input.buffer);
  const meanB0 = new Uint8Array(nifti.createNiftiFromData(input.meanB0, header, { dims: input.dims }));
  input.buffer = null;
  input.data = null;
  input.meanB0 = null;
  globalThis.gc?.();
  const require = createRequire(join(root, 'packages/noddi/package.json'));
  const packageUrl = pathToFileURL(require.resolve('@brainchop/mindgrab/package.json'));
  const driver = await loadMindgrabCpu(packageUrl);
  console.log(`${entry.id}: generating the default MindGrab CPU mask from the full-volume mean b0`);
  const result = await driver.segment(meanB0, MASK_OPTIONS);
  assert.ok(result.mask, 'MindGrab produced its full-volume brain mask');
  const binary = Uint8Array.from(nifti.readNiftiFrames(result.mask).data, value => value > 0 ? 1 : 0);
  const bytes = gzipSync(new Uint8Array(nifti.createNiftiFromData(binary, header, { dims: input.dims })));
  const summary = await inspectScientificImage(bytes, 'neuro:mask');
  const path = join(directory, entry.id, maskName(bidsStem(entry.files.image.name)));
  await writeFile(path, bytes);
  await writeFile(join(directory, entry.id, 'full-mask.json'), JSON.stringify({ path, sourceCommit,
    method: 'NODDI default full-volume mean-b0 MindGrab mask', options: MASK_OPTIONS, backend: result.backend,
    version: JSON.parse(await readFile(packageUrl)).version, sha256: await fileHash(path),
    voxelsInMask: binary.reduce((sum, value) => sum + value, 0), ...summary }, null, 2));
  console.log(`${entry.id}: saved ${path}`);
}

async function runCli(entry) {
  const app = values.app;
  const evidence = join(directory, entry.id, `${app}-cli-evidence`);
  const destination = join(directory, entry.id, `${app}-cli`);
  await mkdir(evidence, { recursive: true });
  const paths = {};
  for (const [role, file] of Object.entries(entry.files)) {
    paths[role] = join(directory, entry.id, file.name);
    assert.ok(await verified(paths[role], file), `Run acquire first: ${paths[role]}`);
  }
  const args = [join(root, 'packages', app, 'bin', `${app}.js`), paths.image];
  if (app === 'noddi') args.push(paths.bval, paths.bvec, destination, '--threads', '2');
  else args.push(destination);
  const mask = app === 'noddi' ? await selectedMask(entry) : undefined;
  if (app === 'noddi' && mask) args.push('--mask', mask);
  const record = { case: entry.id, app, sourceCommit, crop: entry.crop, startedAt: new Date().toISOString(), state: 'running', command: [process.execPath, ...args], inputs: entry.files };
  const reportPath = join(evidence, 'report.json');
  await writeFile(reportPath, `${JSON.stringify(record, null, 2)}\n`);
  const child = spawn(process.execPath, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  const [, , outcome] = await Promise.all([
    pipeline(child.stdout, createWriteStream(join(evidence, 'stdout.log'))),
    pipeline(child.stderr, createWriteStream(join(evidence, 'stderr.log'))),
    exited,
  ]);
  Object.assign(record, outcome, { finishedAt: new Date().toISOString(), state: outcome.code === 0 ? 'succeeded' : outcome.signal ? 'interrupted' : 'failed' });
  if (outcome.code === 0) {
    record.outputs = {};
    try {
      for (const name of await readdir(destination)) {
        const path = join(destination, name);
        const result = { sha256: await fileHash(path), bytes: (await stat(path)).size };
        if (name.endsWith('.nii.gz')) Object.assign(result, await inspectScientificImage(await readFile(path)));
        record.outputs[name] = result;
      }
      assert.ok(Object.keys(record.outputs).length, 'The command line produced output files');
      if (app === 'noddi') assert.ok(Object.keys(record.outputs).some(name => name.includes('_model-noddi_param-icvf_')), 'The multi-shell vendor run produced its NODDI ICVF output');
    } catch (error) {
      record.state = 'verification-failed';
      record.error = String(error.message ?? error);
    }
  }
  if (record.state !== 'succeeded') process.exitCode = 1;
  await writeFile(reportPath, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`${entry.id} ${app} command line: ${record.state}. ${reportPath}`);
}

async function run(entry) {
  const app = values.app;
  const destination = join(directory, entry.id, `${app}-browser`);
  await mkdir(destination, { recursive: true });
  const mask = ['noddi', 'n4'].includes(app) ? await selectedMask(entry) : undefined;
  const record = { case: entry.id, app, sourceCommit, crop: entry.crop, startedAt: new Date().toISOString(), state: 'starting',
    inputs: entry.files, options: ['noddi', 'n4'].includes(app) ? { mask: mask || 'app default' } : {}, console: [], errors: [] };
  record.browserLimits = { reportedHardwareConcurrency: cores };
  record.productionFiles = await inventoryFiles(join(root, 'dist'), app);
  const save = () => writeFile(join(destination, 'report.json'), `${JSON.stringify(record, null, 2)}\n`);
  await save();
  const paths = {};
  for (const [role, file] of Object.entries(entry.files)) {
    const path = join(directory, entry.id, file.name);
    assert.ok(await verified(path, file), `Run acquire first: ${path}`);
    paths[role] = path;
  }
  const server = await serveSite(join(root, 'dist'));
  const browser = await chromium.launch({ headless: true });
  try {
    record.browser = browser.version();
    const context = await browser.newContext({ acceptDownloads: true });
    await context.addInitScript(cores => Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => cores }), cores);
    const page = await context.newPage();
    page.on('pageerror', error => record.errors.push(error.message));
    page.on('console', message => {
      if (message.type() === 'error') record.console.push(message.text());
    });
    const dispatch = (command, request = {}) => page.evaluate(({ command, request }) => globalThis.neurodeskAutomation.dispatch(command, request), { command, request });
    await page.goto(`${server.origin}/${app}/`);
    await page.waitForFunction(() => Boolean(globalThis.neurodeskAutomation), null, { timeout: 60000 });
    const roles = app === 'noddi' ? ['image', 'bval', 'bvec'] : ['image', 'bval', 'bvec', 'sidecar'];
    for (const role of roles) {
      await page.locator('#neurodesk-input-transfer').setInputFiles(paths[role]);
      await dispatch('adopt', { role });
    }
    if (mask && ['noddi', 'n4'].includes(app)) {
      await page.locator('#neurodesk-input-transfer').setInputFiles(mask);
      await dispatch('adopt', { role: 'mask' });
      record.maskSha256 = await fileHash(mask);
    }
    const operation = { noddi: 'fit', degibbs: 'degibbs', dwidenoise: 'denoise', n4: 'correct' }[app];
    await dispatch('start', { operation });
    record.state = 'running';
    await save();
    const deadline = Date.now() + 3600000;
    let snapshot;
    do {
      await page.waitForTimeout(1000);
      snapshot = await dispatch('snapshot');
      assert.ok(Date.now() < deadline, 'The actual vendor run exceeded one hour');
    } while (snapshot.state === 'running');
    record.state = snapshot.state;
    record.report = snapshot.report;
    record.error = snapshot.error;
    assert.equal(snapshot.state, 'succeeded', JSON.stringify(snapshot.error));
    const required = app === 'noddi' ? ['tensor-fa', 'noddi-icvf', 'mask']
      : app === 'n4' ? ['image', 'bias', 'mask', 'bval', 'bvec', 'sidecar'] : ['image', 'bval', 'bvec', 'sidecar'];
    for (const role of required) assert.ok(snapshot.report.artifacts[role], `The vendor run produced ${role}`);
    if (app === 'noddi') assert.equal(snapshot.report.provenance.method, 'dti+noddi-amico', 'The multi-shell vendor run completed tensor and NODDI fitting');
    const wanted = app === 'noddi' ? ['tensor-fa', 'noddi-icvf', 'mask'] : ['image', 'bias', 'mask', 'bval', 'bvec', 'sidecar'];
    record.downloads = {};
    for (const role of wanted.filter(role => snapshot.report.artifacts[role])) {
      const event = page.waitForEvent('download', { timeout: 120000 });
      await dispatch('download', { artifactId: role });
      const download = await event;
      const path = join(destination, download.suggestedFilename());
      await download.saveAs(path);
      const sha256 = await fileHash(path);
      assert.equal(sha256, snapshot.report.artifacts[role].sha256, `${role} matches its report`);
      if (['bval', 'bvec'].includes(role)) assert.equal(sha256, entry.files[role].sha256, `${role} is passed through unchanged`);
      record.downloads[role] = { path, sha256, bytes: (await stat(path)).size };
    }
    await page.screenshot({ path: join(destination, 'completed.png'), fullPage: true });
  } catch (error) {
    record.state = record.state === 'succeeded' ? 'verification-failed' : 'failed';
    record.error = String(error.message ?? error);
    process.exitCode = 1;
  } finally {
    await browser.close();
    await server.close();
  }
  // Inspect downloaded images after closing Chromium, so two full DWI copies
  // do not share memory with the running browser.
  try {
    if (record.state === 'succeeded') {
      for (const file of Object.values(record.downloads).filter(file => file.path.endsWith('.nii.gz'))) {
        const bytes = await readFile(file.path);
        Object.assign(file, await inspectScientificImage(bytes));
      }
    }
  } catch (error) {
    record.state = 'verification-failed';
    record.error = String(error.message ?? error);
    process.exitCode = 1;
  }
  record.finishedAt = new Date().toISOString();
  await save();
  console.log(`${entry.id} ${app}: ${record.state}. ${join(destination, 'report.json')}`);
}
