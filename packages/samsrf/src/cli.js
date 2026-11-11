// The samsrf command line: argument parsing, the analysis and the installation check. bin/samsrf.js
// only calls main; the tests call the parts.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { Worker } from 'node:worker_threads';
import { resolveHemisphere } from './inputs.js';
export { hemisphereOf } from './inputs.js';
import {
  Apertures,
  analysisSpec,
  createJob,
  exportGiis,
  exportConvention,
  predictTimecourse,
  prfProfile,
  readAnalysisInputs,
  runJob,
  shardRanges,
  version as coreVersion,
} from './node.js';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

export const VERSION = packageJson.version;

const KINDS = ['prf', 'rc', 'cf'];

export const HELP = `Usage: samsrf prf|rc|cf MODEL.json OUTPUT_DIR --runs RUN.gii [RUN.gii ...] [options]
       samsrf self-check
       samsrf --version

Runs SamSrf's SamSrfAnalysis on GIfTI time series, as the SamSrf web app does:
  prf  forward-model pRF fit (samsrf_fit_prf)
  rc   reverse-correlation pRF (samsrf_revcor_prf)
  cf   reverse-correlation connective fields (samsrf_revcor_cf)
MODEL.json is a SamSrf model file (Models/Json). Writes SamSrf's GIfTI map set,
<hemisphere>_<Name><suffix>_<map>.gii, and <prefix>_provenance.json into
OUTPUT_DIR, which must be new or empty.

Inputs:
  --runs FILE ...        Functional runs, one GIfTI per run, same vertex count
  --roi FILE             FreeSurfer label of the vertices to analyse
                         (default every vertex)
  --apertures FILE       Stimulus apertures (.mat, .nii, .nii.gz or .gif);
                         prf and rc
  --seed FILE            Seed region label; cf
  --template FILE        Benson template GIfTI (polar angle, eccentricity, ROI); cf
  --surf DIR             FreeSurfer surf folder: reads <hemisphere>.white and
                         <hemisphere>.area from it
  --white FILE           White surface, for Smoothing
  --area FILE            Vertex areas (lh.area), for cf
  --hemisphere NAME      Hemisphere (lh, rh, bi or srf); inferred from matching
                         FreeSurfer/BIDS input names when omitted

Preprocessing (samsrf_gii2srf):
  --no-normalise         Keep the raw time series (SamSrf -norm off); default
                         detrend and z-score each run
  --concatenate          Concatenate the runs (SamSrf -aver off); default average

  --shards N             Split the vertices over N worker threads (default 1);
                         the maps do not depend on N
  -h, --help             Show this help
  -v, --version          Show the version

GIfTI surface input only; no network connection is needed.
"download-models [--cache-dir DIR]" exists for the portable packager and
installs nothing: SamSrf has no model files.`;

const OPTIONS = {
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
  runs: { type: 'string', multiple: true },
  roi: { type: 'string' },
  apertures: { type: 'string' },
  seed: { type: 'string' },
  template: { type: 'string' },
  surf: { type: 'string' },
  white: { type: 'string' },
  area: { type: 'string' },
  hemisphere: { type: 'string' },
  'no-normalise': { type: 'boolean' },
  concatenate: { type: 'boolean' },
  shards: { type: 'string' },
  'cache-dir': { type: 'string' },
};

/**
 * Parses the arguments after the executable. File names that follow --runs belong to it up to the next
 * option, so `--runs lh_uBars*.gii` works. Returns { command, ... }; throws on any usage error.
 */
export function parseCommandLine(argv) {
  const { values, tokens } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, tokens: true, strict: true });
  const positionals = [];
  const runs = [];
  let previous = null;
  for (const token of tokens) {
    if (token.kind === 'option') {
      previous = token.name;
      if (token.name === 'runs') runs.push(token.value);
    } else if (token.kind === 'positional') {
      if (previous === 'runs') runs.push(token.value);
      else positionals.push(token.value);
    } else {
      previous = null;
    }
  }
  if (values.help) return { command: 'help' };
  if (values.version) return { command: 'version' };
  const [command] = positionals;
  if (values['cache-dir'] !== undefined && command !== 'download-models') throw new Error('--cache-dir only applies to download-models.');
  if (command === 'self-check' || command === 'download-models') {
    if (positionals.length !== 1 || runs.length) throw new Error(`${command} does not accept arguments.`);
    return { command, cacheDir: values['cache-dir'] ?? null };
  }
  if (command === undefined) throw new Error('Give an analysis (prf, rc or cf), a model file and an output directory. Use --help for options.');
  if (!KINDS.includes(command)) throw new Error(`Unknown analysis ${JSON.stringify(command)}: use prf, rc or cf.`);
  if (positionals.length !== 3) throw new Error(`Give ${command} a model file and an output directory${positionals.length > 3 ? ` (unexpected ${positionals.slice(3).join(' ')}: run files go after --runs)` : ''}.`);
  if (runs.length === 0) throw new Error('Give the functional runs with --runs.');
  if (command !== 'cf' && values.apertures === undefined) throw new Error(`${command} needs --apertures.`);
  if (command === 'cf' && (values.seed === undefined || values.template === undefined)) throw new Error('cf needs --seed and --template.');
  if (values.surf !== undefined && (values.white !== undefined || values.area !== undefined)) throw new Error('Give either --surf or --white and --area, not both.');
  if (values.hemisphere && !/^[A-Za-z0-9_-]+$/.test(values.hemisphere)) throw new Error(`--hemisphere must be a plain name such as lh or rh, not ${JSON.stringify(values.hemisphere)}.`);
  const hemisphere = resolveHemisphere([...runs, values.roi, values.seed, values.template, values.white, values.area], { hemisphere: values.hemisphere, required: command === 'cf' });
  if (values.surf !== undefined && hemisphere !== 'lh' && hemisphere !== 'rh') throw new Error(`--surf reads lh.* or rh.* files: give --hemisphere lh or rh (it is ${hemisphere}).`);
  const shards = values.shards === undefined ? 1 : Number(values.shards);
  if (!Number.isInteger(shards) || shards < 1 || shards > 256) throw new Error(`--shards must be a whole number from 1 to 256, not ${values.shards}.`);
  return {
    command: 'analyse',
    kind: command,
    model: positionals[1],
    output: positionals[2],
    runs,
    roi: values.roi ?? null,
    apertures: values.apertures ?? null,
    seed: values.seed ?? null,
    template: values.template ?? null,
    white: values.surf === undefined ? values.white ?? null : join(values.surf, `${hemisphere}.white`),
    area: values.surf === undefined ? values.area ?? null : join(values.surf, `${hemisphere}.area`),
    hemisphere,
    normalise: values['no-normalise'] ? 'none' : 'zscore',
    combine: values.concatenate ? 'concatenate' : 'average',
    shards,
  };
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function readModel(path) {
  const text = readFileSync(path, 'utf8');
  try {
    return { text, json: JSON.parse(text) };
  } catch (error) {
    throw new Error(`${path}: not a JSON model file (${error.message})`, { cause: error });
  }
}

// Checked before the analysis and created after it, so a failed run leaves nothing behind.
function checkOutput(path) {
  if (existsSync(path) && readdirSync(path).length) throw new Error(`${path}: the output directory must be new or empty.`);
}

// Runs each shard of the job on its own worker thread, each with its own WebAssembly instance.
function runSharded(spec, shards, total, onProgress) {
  const done = new Array(shards).fill(0);
  return Promise.all(shardRanges(total, shards).map(([start, end], index) => new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./cli-worker.js', import.meta.url), { workerData: { spec, start, end } });
    worker.on('message', (message) => {
      if (message.type === 'progress') {
        done[index] = message.done;
        onProgress?.(done.reduce((sum, value) => sum + value, 0), total);
      } else {
        resolve(message.partial);
      }
    });
    worker.on('error', reject);
    worker.on('exit', (code) => {
      if (code !== 0) reject(new Error(`shard ${index + 1} of ${shards} stopped with exit code ${code}`));
    });
  })));
}

/**
 * Runs one analysis from parsed options and writes its GIfTI maps and provenance into options.output.
 * `log(message)` receives the stages; `progress(done, total, stage)` the vertex count.
 */
export async function analyse(options, { log = () => {}, progress = () => {} } = {}) {
  const started = performance.now();
  const model = readModel(options.model);
  const convention = exportConvention(model.json.Export_Convention);
  checkOutput(options.output);
  log(`Reading and preprocessing ${options.runs.length} run${options.runs.length === 1 ? '' : 's'}`);
  const inputs = readAnalysisInputs({ ...options, precision: model.json.Data_Precision === 'single' ? 'single' : 'double' });
  const spec = analysisSpec(inputs, options.kind, model.text);
  log(options.kind === 'prf' ? 'Generating the search space' : `Preparing the ${options.kind} analysis`);
  let job;
  try {
    job = createJob(spec, options.kind === 'prf' ? (done, total) => progress(done, total, 'search space') : undefined);
  } catch (error) {
    // Model errors start with "model:"; name the file instead.
    throw error.message.startsWith('model:') ? new Error(`${options.model}:${error.message.slice('model:'.length)}`, { cause: error }) : error;
  }
  try {
    const total = job.vertexCount;
    log(`Analysing ${total} vertices${options.shards > 1 ? ` in ${options.shards} shards` : ''}`);
    const onProgress = (done) => progress(done, total, 'vertices');
    let merged;
    if (options.shards === 1) {
      merged = runJob(job, 1, onProgress);
    } else {
      merged = job.merge(await runSharded(spec, options.shards, total, onProgress));
    }
    const prefix = `${options.hemisphere}_${job.modelName}${job.outSuffix}`;
    const files = exportGiis(merged.maps, prefix, null, convention);
    mkdirSync(options.output, { recursive: true });
    for (const { name, bytes } of files) writeFileSync(join(options.output, name), bytes);
    const inputFiles = [
      ...options.runs.map((path) => ['run', path]),
      ['roi', options.roi], ['apertures', options.apertures], ['seed', options.seed],
      ['template', options.template], ['white', options.white], ['area', options.area],
    ].filter(([, path]) => path !== null);
    const provenance = {
      tool: 'samsrf',
      version: VERSION,
      core: coreVersion(),
      source: 'SamSrf (Samuel Schwarzkopf, BSD-3-Clause), commit 41ed1e96, ported to Rust and WebAssembly',
      analysis: options.kind,
      model: model.json,
      exportConvention: convention,
      options: { hemisphere: options.hemisphere, normalise: options.normalise, combine: options.combine, shards: options.shards },
      inputs: inputFiles.map(([role, path]) => ({ role, path, sha256: sha256(readFileSync(path)) })),
      analysedVertices: total,
      maps: merged.maps.values,
      outputs: files.map(({ name }) => name),
      wallTimeSeconds: Number(((performance.now() - started) / 1000).toFixed(1)),
    };
    const provenanceName = `${prefix}_provenance.json`;
    writeFileSync(join(options.output, provenanceName), `${JSON.stringify(provenance, null, 2)}\n`);
    return { prefix, files: [...files.map(({ name }) => name), provenanceName], analysedVertices: total, provenance };
  } finally {
    job.free();
  }
}

// A 5 x 5 aperture swept by five vertical then five horizontal bars, in the documented serialised form.
function selfCheckApertures() {
  const side = 5;
  const frames = [
    ...Array.from({ length: side }, (_, column) => Array.from({ length: side }, (_, row) => row * side + column)),
    ...Array.from({ length: side }, (_, row) => Array.from({ length: side }, (_, column) => row * side + column)),
  ];
  const size = 8 + 5 * 4 + side * side * 16 + frames.reduce((sum, frame) => sum + 4 + frame.length * 12, 0);
  const view = new DataView(new ArrayBuffer(size));
  let offset = 0;
  for (const character of 'SAMSRFAP') view.setUint8(offset++, character.charCodeAt(0));
  for (const value of [1, side, side, frames.length, 0]) {
    view.setUint32(offset, value, true);
    offset += 4;
  }
  for (let row = 0; row < side; row += 1) {
    for (let column = 0; column < side; column += 1) {
      view.setFloat64(offset, column - (side - 1) / 2, true);
      view.setFloat64(offset + 8, (side - 1) / 2 - row, true);
      offset += 16;
    }
  }
  for (const frame of frames) {
    view.setUint32(offset, frame.length, true);
    offset += 4;
    for (const pixel of frame) {
      view.setUint32(offset, pixel, true);
      offset += 4;
    }
    for (let index = 0; index < frame.length; index += 1) {
      view.setFloat64(offset, 1, true);
      offset += 8;
    }
  }
  return new Uint8Array(view.buffer);
}

const SELF_CHECK_MODEL = {
  Name: 'pRF_Gaussian',
  Prf_Function: '@(P,ApWidth) prf_gaussian_rf(P(1), P(2), P(3), ApWidth)',
  Param_Names: ['x0', 'y0', 'Sigma'],
  Scaled_Param: [1, 1, 1],
  Only_Positive: [0, 0, 1],
  Scaling_Factor: 1,
  TR: 1,
  Hrf: 0,
  Aperture_File: 'self-check',
  Coarse_Fit_Only: 1,
  Polar_Search_Space: true,
  Param1: [0, 90, 180, 270],
  Param2: [0.25, 0.5],
  Param3: [0.25, 0.5],
};

/**
 * Fits a coarse pRF to a course generated from a known Gaussian (x0 0.5, y0 0, sigma 0.25) on a tiny
 * in-memory aperture, in two shards, and exports the maps. Throws unless the fit recovers it.
 */
export function selfCheck() {
  const apertures = selfCheckApertures();
  // Vertex 1 follows the prediction of the grid point (polar 0, eccentricity 0.5, sigma 0.25); vertex 2 a sawtooth.
  const read = Apertures.deserialize(apertures);
  let truth;
  try {
    truth = Array.from(predictTimecourse(prfProfile('prf_gaussian_rf', [0.5, 0, 0.25], read.scaledXy(1)), read));
  } finally {
    read.free();
  }
  const sawtooth = truth.map((_, t) => (t % 3) - 1);
  const job = createJob({
    kind: 'prf',
    model: JSON.stringify(SELF_CHECK_MODEL),
    apertures,
    hrf: 'none',
    data: { volumes: truth.length, vertices: Uint32Array.of(1, 2), courses: Float64Array.from([...truth, ...sawtooth]) },
    totalVertices: 3,
  });
  let maps;
  try {
    maps = runJob(job, 2).maps;
  } finally {
    job.free();
  }
  const row = (name) => maps.data.subarray(maps.values.indexOf(name) * 3, (maps.values.indexOf(name) + 1) * 3);
  const [r2, x0, y0, sigma] = ['R^2', 'x0', 'y0', 'Sigma'].map(row);
  if (!(r2[1] > 0.999 && Math.abs(x0[1] - 0.5) < 1e-9 && Math.abs(y0[1]) < 1e-9 && sigma[1] === 0.25 && r2[0] === 0)) {
    throw new Error(`SamSrf failed its self-check: R^2 ${r2[1]}, x0 ${x0[1]}, y0 ${y0[1]}, sigma ${sigma[1]} (expected 1, 0.5, 0, 0.25).`);
  }
  const files = exportGiis(maps, 'srf_self-check');
  if (files.length !== maps.values.length + 2) throw new Error(`SamSrf failed its self-check: exported ${files.length} maps.`);
  return {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    executable: process.execPath,
    samsrf: VERSION,
    core: coreVersion(),
    selfCheck: { r2: r2[1], x0: x0[1], y0: y0[1], sigma: sigma[1], maps: files.length },
  };
}

function progressReporter(stream) {
  let last = '';
  return (done, total, stage) => {
    const percent = total ? Math.floor((done / total) * 100) : 100;
    const line = `${stage} ${percent}%`;
    if (line === last) return;
    last = line;
    if (stream.isTTY) stream.write(`\r${stage} ${done}/${total} (${percent}%)${done === total ? '\n' : ''}`);
    else if (percent % 10 === 0) stream.write(`${stage} ${done}/${total} (${percent}%)\n`);
  };
}

/** Runs the command line; returns the exit code. */
export async function main(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  try {
    const options = parseCommandLine(argv);
    if (options.command === 'help') {
      stdout.write(`${HELP}\n`);
    } else if (options.command === 'version') {
      stdout.write(`samsrf ${VERSION} (SamSrf port core ${coreVersion()})\n`);
    } else if (options.command === 'self-check') {
      stdout.write(`${JSON.stringify(selfCheck())}\n`);
    } else if (options.command === 'download-models') {
      stdout.write(`0 model files: SamSrf has nothing to install${options.cacheDir === null ? '' : ` in ${options.cacheDir}`}\n`);
    } else {
      const result = await analyse(options, {
        log: (message) => stderr.write(`${message}\n`),
        progress: progressReporter(stderr),
      });
      stderr.write(`Wrote ${result.files.length} files for ${result.analysedVertices} vertices in ${result.provenance.wallTimeSeconds} s\n`);
      stdout.write(`${options.output}\n`);
    }
    return 0;
  } catch (error) {
    stderr.write(`${error.message}\n`);
    return 1;
  }
}
