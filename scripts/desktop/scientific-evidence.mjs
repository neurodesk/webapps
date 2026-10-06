import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { arch, cpus, platform, release, totalmem } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
const saveJson = async (path, data) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`);
};
const checksum = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const catalogCases = {
  brain2print: 'hardware inference returns corrected STL, matching MZ3 and the segmented image',
  dwi2trx: 'hardware tractography returns tensor maps and a hashed TRX for the reference DWI',
  syncro: 'full normalization exports all required MNI images and the real pipeline manifest',
  topofit: 'full reconstruction exports every actual surface, QC and processing manifest',
};
const stages = ['probe', 'native', 'webgpu', 'extraction', 'catalog'];

export function verifyPlaywright(report, expectedTitles) {
  const specs = [];
  const visit = (suite) => {
    specs.push(...(suite.specs ?? []));
    for (const child of suite.suites ?? []) visit(child);
  };
  visit(report);
  assert.deepEqual(specs.map((spec) => spec.title).sort(), [...expectedTitles].sort(), 'The required test selection is incomplete or changed');
  assert.equal(report.errors?.length ?? 0, 0, 'Playwright reported a global error');
  for (const spec of specs) {
    assert.equal(spec.tests.length, 1, `${spec.title}: expected one browser execution`);
    const [test] = spec.tests;
    assert.equal(test.expectedStatus, 'passed', `${spec.title}: expected failures do not establish validation`);
    assert.equal(test.status, 'expected', `${spec.title}: test failed or was skipped`);
    assert.equal(test.results.length, 1, `${spec.title}: a retried result is incomplete validation`);
    assert.equal(test.results[0].status, 'passed', `${spec.title}: required test did not complete`);
  }
}

export function verifySynthseg(kind, report) {
  if (kind === 'native') {
    assert.deepEqual([...report.selected_devices].sort(), ['cpu', 'metal']);
    assert.deepEqual(report.failures, []);
    assert.deepEqual(report.results.map(({ device, input, mode }) => `${device}/${input}/${mode}`).sort(),
      ['cpu','metal'].flatMap((device) => ['T1_head','T1_head_2mm'].flatMap((input) => ['fast','default'].map((mode) => `${device}/${input}/${mode}`))).sort());
  } else if (kind === 'native-automation') {
    assert.equal(report.pass, true);
    assert.deepEqual(report.results.map((entry) => entry.case).sort(), ['small_fast','small_default','T1_head_fast','T1_head_default','T1_head_2mm_fast','T1_head_2mm_default'].sort());
  } else {
    assert.equal(report.requireHardware, true);
    assert.notEqual(report.adapter?.isFallbackAdapter, true);
    assert.ok(report.adapter?.info, 'Missing browser adapter identity');
    assert.doesNotMatch(JSON.stringify(report.adapter.info), /swiftshader|llvmpipe|lavapipe/i);
    assert.ok(!report.failure, 'Browser scientific evidence records a failure');
    assert.equal(report.bufferProbe.length, 2);
    for (const probe of report.bufferProbe) {
      assert.equal(probe.validatedLimitBytes, 2 ** 31 - 1, 'The validated SynthSeg buffer cap must not change');
      assert.equal(probe.allocated, false);
    }
    if (kind === 'probe') {
      assert.equal(report.results.length, 0, 'The probe must not run inference');
      return;
    }
    assert.deepEqual(report.results.map(({ input, mode }) => `${basename(input)}/${mode}`).sort(),
      ['small','T1_head','T1_head_2mm'].flatMap((input) => ['fast','default'].map((mode) => `${input}.nii.gz/${mode}`)).sort());
  }
  for (const result of report.results) assert.equal(result.pass, true, 'A scientific case is incomplete or failed');
}

// Downloads an app's pinned example into cache/<app>/, checked against the
// offline asset lock. A cached copy is reused only if it still matches.
export async function fetchPinnedExample(app, exampleId, roles, cache, fetchImpl = fetch) {
  const inventory = await readJson(join(root, 'registry/offline-assets.lock.json'));
  const examples = await readJson(join(root, 'apps', app, 'examples.json'));
  const example = examples.find(({ id }) => id === exampleId);
  assert.ok(example, `${app}: missing pinned example ${exampleId}`);
  const assets = [];
  for (const role of roles) {
    const file = example.files.find((entry) => entry.role === role);
    assert.ok(file && /^[^/\\]+$/.test(file.name), `${app}: missing or invalid example file`);
    assert.match(file.url, /^https:\/\/huggingface\.co\/datasets\/neurodeskorg\/webapps\/resolve\/[a-f0-9]{40}\//);
    const locked = inventory.assets[file.url];
    assert.ok(locked?.sha256 && locked.bytes > 0, `${app}: example has no locked checksum and size`);
    if (file.sha256) assert.equal(file.sha256, locked.sha256);
    const path = resolve(cache, app, file.name);
    await mkdir(dirname(path), { recursive: true });
    let bytes;
    try { bytes = await readFile(path); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      console.log(`Downloading ${app}/${file.name}`);
      const response = await fetchImpl(file.url, { signal: AbortSignal.timeout(600_000) });
      if (!response.ok) throw new Error(`${response.status}: ${file.url}`);
      bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(checksum(bytes), locked.sha256, `${path}: downloaded checksum mismatch`);
      assert.equal(bytes.length, locked.bytes, `${path}: downloaded size mismatch`);
      const temporary = `${path}.${process.pid}.partial`;
      await writeFile(temporary, bytes);
      await rename(temporary, path);
    }
    assert.equal(checksum(bytes), locked.sha256, `${path}: cached checksum mismatch; remove this file and retry`);
    assert.equal(bytes.length, locked.bytes, `${path}: cached size mismatch`);
    assets.push({ app, example: exampleId, role, path, url: file.url, bytes: bytes.length, sha256: locked.sha256 });
  }
  return assets;
}

export async function prepareCatalog(cache, evidence, fetchImpl = fetch) {
  const assets = [];
  for (const [app, exampleId, roles] of [['dwi2trx','dwi-gradients',['image','bval','bvec']], ['syncro','trace-t1',['primary']], ['topofit','openneuro-t1',['image']]]) {
    assets.push(...await fetchPinnedExample(app, exampleId, roles, cache, fetchImpl));
  }
  const path = join(root, 'exes/synthseg/test/fixtures/small.nii.gz');
  const bytes = await readFile(path);
  assets.push({ app: 'brain2print', role: 'image', path, source: 'committed Brain2Print regression fixture', bytes: bytes.length, sha256: checksum(bytes) });
  await saveJson(join(evidence, 'catalog-fixtures.json'), { assets });
  return assets;
}

// Playwright's pinned trace format serializes JSON values as tagged primitives/objects.
export function decodeTraceValue(value, references = new Map()) {
  if (!value || typeof value !== 'object') return value;
  for (const key of ['s','n','b']) if (Object.hasOwn(value, key)) return value[key];
  if (value.v === 'null') return null;
  if (value.v === 'undefined') return undefined;
  if (value.ref !== undefined) return references.get(value.ref);
  if (value.a) {
    const result = [];
    references.set(value.id, result);
    result.push(...value.a.map((entry) => decodeTraceValue(entry, references)));
    return result;
  }
  if (value.o) {
    const result = {};
    references.set(value.id, result);
    for (const { k, v } of value.o) result[k] = decodeTraceValue(v, references);
    return result;
  }
  return undefined;
}

export function verifyCatalogReports(app, reports) {
  assert.equal(reports.length, 1, `${app}: missing or ambiguous completed automation report in the trace`);
  const [report] = reports;
  assert.equal(report.app, app);
  assert.equal(report.status, 'succeeded');
  const roles = Object.values(report.artifacts).map(({ role }) => role);
  for (const artifact of Object.values(report.artifacts)) {
    assert.match(artifact.sha256, /^[a-f0-9]{64}$/);
    assert.ok(artifact.bytes > 0);
  }
  if (app === 'brain2print') {
    assert.deepEqual(roles.sort(), ['geometry','mesh','segmentation']);
    assert.equal(report.provenance.segmentation.backend, 'webgpu', 'Brain2Print fell back from hardware WebGPU');
    assert.equal(report.measurements.manifold, true);
    assert.equal(report.measurements.consistent, true);
    assert.ok(report.measurements.signedVolume > 0);
  } else if (app === 'dwi2trx') {
    assert.deepEqual(roles.sort(), ['fa','tracts','v1']);
    assert.ok(report.measurements.streamlines > 0);
    assert.equal(report.measurements.partial, false, 'Tracking was capped or truncated; full workflow validation is incomplete');
  } else if (app === 'syncro') {
    assert.deepEqual(roles.sort(), ['details','native-synthetic','normalized-brain','normalized-primary','synthetic-brain']);
  } else if (app === 'topofit') {
    assert.equal(roles.filter((role) => role === 'surface').length, 6);
    assert.equal(roles.filter((role) => role === 'registration').length, 2);
    assert.ok(roles.includes('qc') && roles.includes('metadata'));
    assert.ok(report.provenance.runtime.assets);
  }
}

export async function extractTraceReports(directory, app) {
  const traces = [];
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.name === 'trace.zip') traces.push(path);
    }
  };
  await visit(directory);
  const reports = new Map();
  for (const path of traces) {
    const entries = execFileSync('unzip', ['-Z1', path], { encoding: 'utf8' }).split('\n').filter((name) => name.endsWith('.trace'));
    for (const entry of entries) {
      const lines = execFileSync('unzip', ['-p', path, entry], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
      for (const line of lines.split('\n').filter(Boolean)) {
        const event = JSON.parse(line);
        const value = decodeTraceValue(event.result?.value);
        const report = value?.report ?? value;
        if (report?.app === app && report.status === 'succeeded' && report.artifacts) reports.set(report.runId, report);
      }
    }
  }
  const result = [...reports.values()];
  await saveJson(join(directory, 'reports.json'), { app, traces: traces.map((path) => relative(directory, path)), reports: result });
  return result;
}

async function configuration(app, evidence) {
  assert.ok(Object.hasOwn(catalogCases, app));
  const directory = join(evidence, 'catalog', app);
  await mkdir(directory, { recursive: true });
  const appDirectory = join(root, 'apps', app);
  const config = `import base from ${JSON.stringify(pathToFileURL(join(appDirectory, 'playwright.config.js')).href)};
export default {
  ...base,
  testDir: ${JSON.stringify(join(appDirectory, 'e2e'))},
  workers: 1,
  retries: 0,
  outputDir: ${JSON.stringify(directory)},
  preserveOutput: 'always',
  reporter: [['line'], ['json', { outputFile: ${JSON.stringify(join(directory, 'playwright.json'))} }]],
  webServer: { ...base.webServer, cwd: ${JSON.stringify(appDirectory)}, reuseExistingServer: false, timeout: 1200000 },
  use: { ...base.use, headless: false, trace: 'on', screenshot: 'only-on-failure', launchOptions: { ...base.use?.launchOptions, args: ['--enable-unsafe-webgpu', '--use-angle=metal', '--enable-features=Metal'] } },
};
`;
  const path = join(evidence, `${app}.config.mjs`);
  await writeFile(path, config);
  return path;
}

async function main([command, ...args]) {
  if (command === 'init') {
    const [directory, stage] = args;
    const selected = stage === 'all' ? stages : stage === 'catalog' ? ['probe','catalog'] : [stage];
    const profile = JSON.parse(execFileSync('system_profiler', ['SPHardwareDataType','SPDisplaysDataType','-json'], { encoding: 'utf8' }));
    const redact = (value) => Array.isArray(value) ? value.map(redact) : value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).filter(([key]) => !/serial|uuid|udid/i.test(key)).map(([key, entry]) => [key, redact(entry)])) : value;
    const versions = Object.fromEntries([['pnpm',['--version']], ['rustc',['--version']], ['cargo',['--version']], ['python3',['--version']]].map(([command, options]) => {
      try { return [command, execFileSync(command, options, { encoding: 'utf8', stdio: ['ignore','pipe','ignore'] }).trim()]; }
      catch { return [command, null]; }
    }));
    await saveJson(join(directory, 'hardware.json'), { versions, platform: platform(), release: release(), architecture: arch(), cpu: cpus()[0]?.model, memoryBytes: totalmem(), node: process.version, systemProfiler: redact(profile) });
    await saveJson(join(directory, 'stages.json'), { schemaVersion: 1, startedAt: new Date().toISOString(), requested: stage, status: 'running', stages: Object.fromEntries(stages.map((name) => [name, { status: selected.includes(name) ? 'pending' : 'not-requested' }])) });
  } else if (command === 'status') {
    const [directory, stage, status] = args;
    const report = await readJson(join(directory, 'stages.json'));
    report.stages[stage] = { ...report.stages[stage], status, updatedAt: new Date().toISOString() };
    await saveJson(join(directory, 'stages.json'), report);
  } else if (command === 'finish') {
    const [directory, code] = args;
    const report = await readJson(join(directory, 'stages.json'));
    for (const stage of Object.values(report.stages)) if (stage.status === 'running') stage.status = 'failed';
    report.status = Number(code) === 0 && Object.values(report.stages).every(({ status }) => ['completed','not-requested'].includes(status)) ? 'completed' : 'incomplete';
    report.exitCode = Number(code);
    report.finishedAt = new Date().toISOString();
    await saveJson(join(directory, 'stages.json'), report);
  } else if (command === 'prepare-catalog') await prepareCatalog(resolve(args[0]), resolve(args[1]));
  else if (command === 'config') console.log(await configuration(args[0], resolve(args[1])));
  else if (command === 'catalog-title') console.log(catalogCases[args[0]]);
  else if (command === 'check-catalog') {
    const [app, directory] = args;
    verifyPlaywright(await readJson(join(directory, 'playwright.json')), [catalogCases[app]]);
    verifyCatalogReports(app, await extractTraceReports(directory, app));
  } else if (command === 'check-playwright') verifyPlaywright(await readJson(args[0]), args.slice(1));
  else if (command === 'check-synthseg') verifySynthseg(args[0], await readJson(args[1]));
  else throw new Error(`Unknown evidence command: ${command}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main(process.argv.slice(2));
}
