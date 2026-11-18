#!/usr/bin/env node
// Runs cli_plan.py's SamSrfAnalysis matrix through the PRODUCTION SamSrf web app
// (a built apps/samsrf bundle served with its own COOP/COEP headers), driving its
// interface as a person would: choose the analysis, load the run's model JSON, set
// how runs combine, drop each input into its field, press Run, then "Download all".
//
// For every run it keeps the downloaded zip (compare_ui_cli.py reads its GIfTIs), the model the app saved
// with "Save model JSON" just before running (what the app actually ran), the status
// line and the app's own refusal text. Nothing is translated by this script beyond
// what a person would do: the model is the CLI model plus Data_Precision (the
// precision SamSrf_defaults.json's def_64bit selects for MATLAB); the app itself
// replaces the model's file fields with the names of the files given to it.
//
// Usage: node run_ui_matrix.mjs APP_URL PLAN_JSON BUNDLE BUNDLE_SHA256_JSON OUTPUT_ROOT
//
// Each run gets one status, which compare_ui_cli.py checks again:
// - `refused` / `unsupported`: the app showed exactly the refusal expectedOutcome names
//   for this run (when the model loads, or when Run is pressed) and offered nothing.
//   Any other refusal, crash or load failure is `failed`. Neither is agreement.
// - `succeeded`: the status line shows the run's outcome, the app offers the download,
//   and the page threw nothing.
// - `succeeded-ui-error`: the app offered a result, then showed an error or threw. The
//   zip is kept and the error is `uiError`; the workflow did not complete.
// - `failed`: anything else.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { expectedEngineOutcome, isEntry, treeHashes } from './run_web_matrix.mjs';

const INPUT = '/input';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const OUTCOME = { prf: 'pRF maps ready', rc: 'Reverse-correlation maps ready', cf: 'Connective field maps ready' };
// apps/samsrf/src/models.js parseModel, shown when the model loads.
const MODEL_REFUSALS = {
  rc: 'Single precision reverse correlation supports the convex hull; 2D pRF fits need double precision.',
  cf: 'Single precision connective fields support Fit_pRF 0 or -1; Gaussian fits need double precision.',
};

/** What the app must do with a plan run; compare_ui_cli.py's expected_ui_outcome says the same. The app
 * refuses at model load what the engine would refuse; a run that names a subject-HRF file gets it. */
export function expectedOutcome(run) {
  const engine = expectedEngineOutcome(run, 'browser');
  if (engine.status === 'refused') return { status: 'refused', stage: 'model', message: MODEL_REFUSALS[run.algorithm] };
  if (engine.status === 'unsupported') return { status: 'unsupported', stage: 'run', message: engine.message };
  return { status: 'succeeded' };
}

/** The files and settings a person gives the app for one plan run. */
export function uiRun(run, bundle) {
  const [algorithm, , runs] = run.argv;
  const option = (name) => run.argv.find((value) => value.startsWith(`-${name}=`))?.slice(name.length + 2) ?? null;
  const local = (path) => path.replace(INPUT, bundle);
  const hemisphere = run.dataset.endsWith('_rh') ? 'rh' : 'lh';
  const dataset = join(bundle, run.dataset);
  if (runs !== `${INPUT}/${run.dataset}/${hemisphere}_ubars*.gii`) throw new Error(`${run.id}: unexpected run wildcard ${runs}`);
  if (option('norm') !== '1') throw new Error(`${run.id}: only -norm=1 is planned`);
  const model = { ...run.model, Data_Precision: run.precision };
  const files = {
    runs: readdirSync(dataset).filter((name) => new RegExp(`^${hemisphere}_ubars\\d+\\.gii$`).test(name)).sort().map((name) => join(dataset, name)),
    roi: [`${local(option('roi'))}.label`],
    surfaces: ['white', 'area'].map((kind) => join(local(option('surf')), `${hemisphere}.${kind}`)),
  };
  if (model.Aperture_File) files.apertures = [`${local(model.Aperture_File)}.mat`];
  if (typeof model.Hrf === 'string' && model.Hrf.startsWith('hrf_')) files.subjectHrf = [join(bundle, `${model.Hrf}.mat`)];
  if (algorithm === 'cf') {
    files.template = [join(dataset, `${hemisphere}_benson.gii`)];
    files.seed = [`${local(model.SeedRoi)}.label`];
  }
  return { algorithm, model, files, combine: option('aver') === '1' ? 'average' : 'concatenate' };
}

const payload = (path) => ({ name: basename(path), mimeType: 'application/octet-stream', buffer: readFileSync(path) });

async function statusText(page) {
  return (await page.locator('#statusText').textContent())?.trim() ?? '';
}

/** Drives one plan run through the app in a fresh browser context and returns its record. */
export async function runOne(browser, url, run, bundle, directory, served) {
  const started = performance.now();
  const record = { id: run.id, precision: run.precision, algorithm: run.algorithm };
  const context = await browser.newContext({ acceptDownloads: true, serviceWorkers: 'block' });
  // Every WebAssembly module the app fetches, workers included, by URL and SHA-256.
  context.on('response', (response) => {
    if (!response.url().endsWith('.wasm')) return;
    void response.body().then((body) => { served[response.url()] = sha256(body); }).catch(() => {});
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  try {
    const plan = uiRun(run, bundle);
    const expected = expectedOutcome(run);
    record.files = Object.fromEntries(Object.entries(plan.files).map(([slot, paths]) => [slot, paths.map((path) => basename(path))]));
    record.combine = plan.combine;
    await page.goto(url);
    if (!(await page.evaluate(() => self.crossOriginIsolated === true))) throw new Error('the page is not cross-origin isolated');
    await page.locator('#analysis').selectOption(plan.algorithm);
    await page.locator('#modelInput').setInputFiles({ name: `${run.id}.json`, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(plan.model)) });
    await page.waitForFunction(() => !/ selected$/.test(document.querySelector('#statusText')?.textContent?.trim() ?? ''));
    const loaded = await statusText(page);
    if (!loaded.startsWith('Model ')) {
      const refused = expected.status === 'refused' && expected.stage === 'model' && loaded === expected.message;
      Object.assign(record, { status: refused ? 'refused' : 'failed', stage: 'model', message: loaded });
      return record;
    }
    await page.locator('#combine').selectOption(plan.combine);
    await page.locator('#normalise').setChecked(true);
    for (const slot of ['runs', 'apertures', 'roi', 'surfaces', 'template', 'seed', 'subjectHrf']) {
      if (plan.files[slot]) await page.locator(`#${slot}Input`).setInputFiles(plan.files[slot].map(payload));
    }
    await page.waitForFunction(() => document.querySelector('#statusText')?.textContent?.trim() === 'Ready', null, { timeout: 120000 });
    mkdirSync(directory, { recursive: true });
    await page.locator('#advancedSettings').evaluate((element) => { element.open = true; });
    const [saved] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Save model JSON' }).click()]);
    const modelBytes = readFileSync(await saved.path());
    writeFileSync(join(directory, 'app-model.json'), modelBytes);
    record.appModelSha256 = sha256(modelBytes);
    const button = page.locator('#runButton');
    if (!(await button.isEnabled())) throw new Error(`Run is disabled: ${await page.locator('#runHint').textContent()}`);
    // The app locks Run while it works and unlocks it with the outcome or the error in the status line.
    await button.click();
    await page.waitForFunction(() => document.querySelector('#runButton').disabled, null, { timeout: 60000 }).catch(() => {});
    await page.waitForFunction(() => !document.querySelector('#runButton').disabled, null, { timeout: 3600000 });
    const outcome = await statusText(page);
    record.statusText = outcome;
    if (!(await page.locator('#downloadAll').isEnabled())) {
      const unsupported = expected.status === 'unsupported' && expected.stage === 'run' && outcome === expected.message;
      Object.assign(record, { status: unsupported ? 'unsupported' : 'failed', stage: 'run', runMessage: outcome });
      return record;
    }
    // The app offers a result: keep it whatever the status line says, so its maps can be compared.
    const [archive] = await Promise.all([page.waitForEvent('download'), page.locator('#downloadAll').click()]);
    const zipBytes = readFileSync(await archive.path());
    writeFileSync(join(directory, archive.suggestedFilename()), zipBytes);
    Object.assign(record, { zip: archive.suggestedFilename(), zipSha256: sha256(zipBytes) });
    if (outcome.includes(OUTCOME[plan.algorithm]) && !pageErrors.length) {
      record.status = 'succeeded';
    } else {
      Object.assign(record, { status: 'succeeded-ui-error', uiError: pageErrors.length ? pageErrors.join('; ') : outcome });
    }
  } catch (error) {
    record.status = 'failed';
    record.message = error.message;
  } finally {
    record.pageErrors = pageErrors;
    record.seconds = Number(((performance.now() - started) / 1000).toFixed(1));
    await context.close();
  }
  return record;
}

async function main([url, planPath, bundle, manifestPath, output, ...rest]) {
  if (!output || rest.length) throw new Error('Usage: node run_ui_matrix.mjs APP_URL PLAN_JSON BUNDLE BUNDLE_SHA256_JSON OUTPUT_ROOT');
  if (existsSync(output)) throw new Error(`${output} must not exist`);
  const expected = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const before = treeHashes(bundle);
  const sorted = Object.fromEntries(Object.entries(expected).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  if (JSON.stringify(before) !== JSON.stringify(sorted)) throw new Error('The bundle differs from its recorded SHA-256 hashes');
  const plan = JSON.parse(readFileSync(planPath, 'utf8'));
  mkdirSync(output);
  // Imported here so that uiRun loads without the package's devDependencies (test_ui_cli.py).
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  const environment = {
    runner: 'production-ui',
    engine: 'built apps/samsrf served by vite preview, driven through its interface',
    url,
    chromium: browser.version(),
    planSha256: sha256(readFileSync(planPath)),
    bundleSha256: sha256(readFileSync(manifestPath)),
  };
  writeFileSync(join(output, 'environment.json'), `${JSON.stringify(environment, null, 2)}\n`);
  const runs = [];
  const served = {};
  try {
    for (const run of plan.runs) {
      const record = await runOne(browser, url, run, bundle, join(output, run.id), served);
      runs.push(record);
      writeFileSync(join(output, `${run.id}.ui.json`), `${JSON.stringify(record, null, 2)}\n`);
      console.log(`${record.status.padEnd(11)} ${run.id} ${record.seconds} s${record.message || record.runMessage ? `: ${record.message ?? record.runMessage}` : ''}`);
    }
  } finally {
    await browser.close();
  }
  if (JSON.stringify(treeHashes(bundle)) !== JSON.stringify(before)) throw new Error('The bundle changed during the UI runs');
  const wasm = [...new Set(Object.values(served))];
  if (wasm.length !== 1) throw new Error(`expected one served WebAssembly module, saw ${JSON.stringify(served)}`);
  writeFileSync(join(output, 'environment.json'), `${JSON.stringify({ ...environment, wasmSha256: wasm[0], wasmUrls: Object.keys(served).sort() }, null, 2)}\n`);
  writeFileSync(join(output, 'runs.json'), `${JSON.stringify(runs.map(({ id, status, stage, message, runMessage, seconds, zipSha256 }) => ({ id, status, stage, message, runMessage, seconds, zipSha256 })), null, 2)}\n`);
}

if (isEntry(import.meta.url, process.argv[1])) await main(process.argv.slice(2));
