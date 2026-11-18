#!/usr/bin/env node
// Runs cli_plan.py's SamSrfAnalysis matrix through the web app's engine (the committed
// WebAssembly module, loaded as the browser loads it) on the same read-only bundle.
// compare_web_cli.py then holds each run against a MATLAB execution of the matrix
// (source MATLAB, or the compiled image once one exists).
//
// Usage: node run_web_matrix.mjs PLAN_JSON BUNDLE BUNDLE_SHA256_JSON OUTPUT_ROOT
//
// Each run's model is the CLI model with these translations, all recorded in the run's
// web.json: Data_Precision carries the precision that SamSrf_defaults.json's def_64bit
// selects for MATLAB, a forward model's Css_Convention is "samsrf" because SamSrf always
// takes complex CSS powers (the engine's default clips negative responses instead), and
// bundle paths replace /input. Inputs the web engine takes in another form are named
// there too: the Benson template GIfTI (MATLAB reads the .mat prepare_cli_bundle.m
// derived from it) and the subject-HRF file, which the engine API takes as a kernel
// (`hrf.oldSchool` of its fP, as apps/samsrf/src/engine.js builds it). Where MATLAB's
// Srf.Data is complex, maps.imag.f64 holds the engine's imaginary parts beside maps.f64.
// A run the engine refuses with exactly the text expectedEngineOutcome names is written
// as refused, with its message; any other failure is failed. Neither is a pass.
import { createHash } from 'node:crypto';
import { cpus } from 'node:os';
import { mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as samsrf from '../../src/node.js';

const INPUT = '/input';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** SHA-256 of every file under root, by POSIX relative path, sorted. */
export function treeHashes(root) {
  const hashes = {};
  const visit = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const stat = statSync(path, { throwIfNoEntry: true });
      if (stat.isDirectory()) visit(path);
      else hashes[relative(root, path).split('\\').join('/')] = sha256(readFileSync(path));
    }
  };
  visit(root);
  return Object.fromEntries(Object.entries(hashes).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** What the engine must do with a plan run on this runner, with the exact text of an expected
 * refusal; compare_web_cli.py's expected_web_outcome says the same. */
export function expectedEngineOutcome({ algorithm, model, precision }, runner) {
  // exes/samsrf/core/src/model.rs: Error::NotImplemented.
  if (precision === 'single' && algorithm === 'rc' && (model.Prf_Function ?? 0) !== 0) {
    return { status: 'refused', message: 'Data_Precision=single with a Prf_Function fit is not supported by this port' };
  }
  if (precision === 'single' && algorithm === 'cf' && model.Fit_pRF === 1) {
    return { status: 'refused', message: 'Data_Precision=single with Fit_pRF=1 is not supported by this port' };
  }
  return { status: 'succeeded' };
}

/** The status of a run the engine did not finish: refused or unsupported only with exactly the expected text. */
export function failureStatus(run, runner, message) {
  const expected = expectedEngineOutcome(run, runner);
  return expected.status !== 'succeeded' && message === expected.message ? expected.status : 'failed';
}

/** The plan model as both harnesses give it to the engine: the CLI model plus Data_Precision (the
 * precision def_64bit selects for MATLAB) and, for a forward model, Css_Convention "samsrf", because
 * SamSrf always takes complex CSS powers while the engine's default clips negative responses.
 * compare_ui_cli.py's expected_app_model says the same of the model the app saves. */
export function matlabModel(run) {
  const model = { ...run.model, Data_Precision: run.precision };
  if (run.algorithm === 'prf') model.Css_Convention = 'samsrf';
  return model;
}

/** Translates one plan run into the readAnalysisInputs options, the model text and the HRF override. */
export function webRun(run, bundle) {
  const local = (path) => path.replace(INPUT, bundle);
  const argv = run.argv;
  const option = (name) => argv.find((value) => value.startsWith(`-${name}=`))?.slice(name.length + 2) ?? null;
  const [algorithm, , runs] = argv;
  const hemisphere = run.dataset.endsWith('_rh') ? 'rh' : 'lh';
  const dataset = join(bundle, run.dataset);
  const runFiles = readdirSync(dataset).filter((name) => new RegExp(`^${hemisphere}_ubars\\d+\\.gii$`).test(name)).sort().map((name) => join(dataset, name));
  if (runs !== `${INPUT}/${run.dataset}/${hemisphere}_ubars*.gii` || !runFiles.length) throw new Error(`${run.id}: unexpected run wildcard ${runs}`);
  if (option('norm') !== '1') throw new Error(`${run.id}: only -norm=1 is planned`);
  const model = matlabModel(run);
  const translations = { Data_Precision: run.precision };
  if (model.Css_Convention) {
    translations.Css_Convention = 'samsrf (SamSrf\'s complex CSS powers; the engine default clips negative responses)';
  }
  const options = {
    runs: runFiles,
    roi: `${local(option('roi'))}.label`,
    hemisphere,
    normalise: 'zscore',
    combine: option('aver') === '1' ? 'average' : 'concatenate',
    precision: run.precision,
    apertures: null,
    seed: null,
    template: null,
    white: join(local(option('surf')), `${hemisphere}.white`),
    area: join(local(option('surf')), `${hemisphere}.area`),
  };
  if (model.Aperture_File) {
    options.apertures = `${local(model.Aperture_File)}.mat`;
    translations.Aperture_File = options.apertures;
  }
  if (algorithm === 'cf') {
    options.seed = `${local(model.SeedRoi)}.label`;
    options.template = join(dataset, `${hemisphere}_benson.gii`);
    translations.Template = `${options.template} (MATLAB: ${model.Template})`;
    translations.SeedRoi = options.seed;
  }
  let hrf;
  if (typeof model.Hrf === 'string' && model.Hrf.startsWith('hrf_')) {
    const file = join(bundle, `${model.Hrf}.mat`);
    const fp = samsrf.readOldSchoolHrf(readFileSync(file));
    hrf = samsrf.hrf.oldSchool(model.TR, fp);
    translations.Hrf = { route: 'engine API kernel hrf.oldSchool(TR, fP), as apps/samsrf/src/engine.js builds it', file, fP: Array.from(fp) };
  }
  return { algorithm, options, model, hrf, translations };
}

function runOne(run, bundle, directory) {
  const started = performance.now();
  const record = { id: run.id, precision: run.precision, algorithm: run.algorithm };
  let job;
  try {
    const translated = webRun(run, bundle);
    record.translations = translated.translations;
    record.options = { ...translated.options };
    const inputs = samsrf.readAnalysisInputs(translated.options);
    const spec = samsrf.analysisSpec(inputs, translated.algorithm, translated.model);
    if (translated.hrf) spec.hrf = translated.hrf;
    try {
      job = samsrf.createJob(spec);
    } catch (error) {
      record.status = failureStatus(run, 'node', error.message);
      record.message = error.message;
      return record;
    }
    const { maps, imaginary } = samsrf.runJob(job, 1);
    const prefix = `${translated.options.hemisphere}_${job.modelName}${job.outSuffix}`;
    mkdirSync(directory, { recursive: true });
    const files = samsrf.exportGiis(maps, prefix, null, translated.model.Export_Convention);
    for (const { name, bytes } of files) {
      writeFileSync(join(directory, name), bytes);
    }
    record.files = files.map(({ name }) => name);
    // The analysed ROI in label order, 0-based; MATLAB's Srf.Roi is the same list, 1-based.
    record.roi = Array.from(inputs.roi ?? []);
    const data = Float64Array.from(maps.data);
    writeFileSync(join(directory, 'maps.f64'), new Uint8Array(data.buffer));
    let imaginarySha256 = null;
    if (imaginary) {
      const bytes = new Uint8Array(Float64Array.from(imaginary).buffer);
      writeFileSync(join(directory, 'maps.imag.f64'), bytes);
      imaginarySha256 = sha256(bytes);
    }
    Object.assign(record, {
      status: 'succeeded',
      prefix,
      values: maps.values,
      vertices: maps.vertices,
      analysed: job.vertexCount,
      mapsSha256: sha256(new Uint8Array(data.buffer)),
      imaginarySha256,
    });
  } catch (error) {
    record.status = 'failed';
    record.message = error.message;
  } finally {
    job?.free();
    record.seconds = Number(((performance.now() - started) / 1000).toFixed(1));
  }
  return record;
}

/** Same-file test for the entry module, through symbolic links (a checkout under /home may resolve to /storage). */
export function isEntry(moduleUrl, argv1) {
  if (!argv1) return false;
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argv1);
  } catch {
    return false;
  }
}

function main([planPath, bundle, manifestPath, output, ...rest]) {
  if (!output || rest.length) throw new Error('Usage: node run_web_matrix.mjs PLAN_JSON BUNDLE BUNDLE_SHA256_JSON OUTPUT_ROOT');
  if (existsSync(output)) throw new Error(`${output} must not exist`);
  const expected = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const before = treeHashes(bundle);
  if (JSON.stringify(before) !== JSON.stringify(Object.fromEntries(Object.entries(expected).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))))) {
    throw new Error('The bundle differs from its recorded SHA-256 hashes');
  }
  const plan = JSON.parse(readFileSync(planPath, 'utf8'));
  mkdirSync(output);
  const wasm = new URL('../../wasm/samsrf_wasm_bg.wasm', import.meta.url);
  const environment = {
    runner: 'node',
    engine: 'web app WebAssembly module, Node',
    packageVersion: JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version,
    core: samsrf.version(),
    wasmSha256: sha256(readFileSync(wasm)),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    cpu: cpus()[0]?.model ?? null,
    threads: 1,
    planSha256: sha256(readFileSync(planPath)),
    bundleSha256: sha256(readFileSync(manifestPath)),
  };
  writeFileSync(join(output, 'environment.json'), `${JSON.stringify(environment, null, 2)}\n`);
  const runs = [];
  for (const run of plan.runs) {
    const record = runOne(run, bundle, join(output, run.id));
    runs.push(record);
    writeFileSync(join(output, `${run.id}.web.json`), `${JSON.stringify(record, null, 2)}\n`);
    console.log(`${record.status.padEnd(9)} ${run.id} ${record.seconds} s${record.message ? `: ${record.message}` : ''}`);
  }
  if (JSON.stringify(treeHashes(bundle)) !== JSON.stringify(before)) throw new Error('The bundle changed during the web runs');
  writeFileSync(join(output, 'runs.json'), `${JSON.stringify(runs.map(({ id, status, message, seconds, mapsSha256 }) => ({ id, status, message, seconds, mapsSha256 })), null, 2)}\n`);
}

if (isEntry(import.meta.url, process.argv[1])) main(process.argv.slice(2));
