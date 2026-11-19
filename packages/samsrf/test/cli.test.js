import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { hemisphereOf, main, parseCommandLine } from '../src/cli.js';
import { analysisSpec, createJob, exportGiis, hrf, readAnalysisInputs, readGifti, readOldSchoolHrf, runJob } from '../src/node.js';
import { MODELS } from '../validation/example-inputs.mjs';
import { giftiRun, matFile } from './fixtures.js';

const BIN = fileURLToPath(new URL('../bin/samsrf.js', import.meta.url));
// The web app's example files (apps/samsrf/examples.json, downloaded flat into one folder).
const dir = process.env.SAMSRF_WEBAPP_EXAMPLE_DIR;

function scratch(t) {
  const path = mkdtempSync(join(tmpdir(), 'samsrf-cli-test-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

function sink() {
  let text = '';
  return { write: (chunk) => { text += chunk; }, get text() { return text; } };
}

async function run(argv) {
  const stdout = sink();
  const stderr = sink();
  const code = await main(argv, { stdout, stderr });
  return { code, stdout: stdout.text, stderr: stderr.text };
}

test('parseCommandLine reads an analysis, with the run files that follow --runs', () => {
  const options = parseCommandLine([
    'cf', 'model.json', 'out', '--seed', 'rh.V1.label', '--runs', 'rh_a.gii', 'rh_b.gii', '--template', 'benson.gii',
    '--surf', 'surf', '--no-normalise', '--concatenate', '--shards', '4', '--runs', 'rh_c.gii',
  ]);
  assert.deepEqual(options, {
    command: 'analyse',
    kind: 'cf',
    model: 'model.json',
    output: 'out',
    runs: ['rh_a.gii', 'rh_b.gii', 'rh_c.gii'],
    roi: null,
    apertures: null,
    seed: 'rh.V1.label',
    template: 'benson.gii',
    white: join('surf', 'rh.white'),
    area: join('surf', 'rh.area'),
    subjectHrf: null,
    hemisphere: 'rh',
    normalise: 'none',
    combine: 'concatenate',
    shards: 4,
  });
  const rc = parseCommandLine(['rc', 'm.json', 'out', '--runs', 'run1.gii', '--apertures', 'aps.mat', '--hemisphere', 'lh']);
  assert.equal(rc.hemisphere, 'lh');
  assert.equal(rc.normalise, 'zscore');
  assert.equal(rc.combine, 'average');
  assert.equal(rc.shards, 1);
  assert.equal(rc.subjectHrf, null);
  assert.equal(parseCommandLine(['rc', 'm.json', 'out', '--runs', 'run1.gii', '--apertures', 'aps.mat', '--hrf', 'data/hrf_sub01.mat']).subjectHrf, 'data/hrf_sub01.mat');
  assert.equal(parseCommandLine(['rc', 'm.json', 'out', '--runs', 'run1.gii', '--apertures', 'aps.mat']).hemisphere, 'srf');
  assert.equal(parseCommandLine(['rc', 'm.json', 'out', '--runs', 'lh_run.gii', '--apertures', 'aps.mat', '--hemisphere', 'srf']).hemisphere, 'srf');
});

test('hemisphereOf reads lh, rh or bi from the start of the file name', () => {
  assert.equal(hemisphereOf('/data/lh_uBars1.gii'), 'lh');
  assert.equal(hemisphereOf('RH.run.gii'), 'rh');
  assert.equal(hemisphereOf('bi_run.gii'), 'bi');
  assert.equal(hemisphereOf('lhrun.gii'), 'srf');
  assert.equal(hemisphereOf('sub-01_lh.gii'), 'lh');
});

test('parseCommandLine refuses incomplete or contradictory arguments', () => {
  const base = ['rc', 'm.json', 'out', '--runs', 'lh_1.gii', '--apertures', 'aps.mat'];
  const cases = [
    [[], /Give an analysis/],
    [['glm', 'm.json', 'out', '--runs', 'a.gii'], /Unknown analysis "glm"/],
    [['rc', 'm.json'], /model file and an output directory/],
    [['rc', 'm.json', 'out', 'extra', '--runs', 'a.gii'], /unexpected extra: run files go after --runs/],
    [['rc', 'm.json', 'out', '--apertures', 'aps.mat'], /--runs/],
    [['prf', 'm.json', 'out', '--runs', 'a.gii'], /prf needs --apertures/],
    [['cf', 'm.json', 'out', '--runs', 'a.gii', '--seed', 's.label'], /cf needs --seed and --template/],
    [[...base, '--surf', 'surf', '--white', 'lh.white'], /either --surf or --white and --area/],
    [['rc', 'm.json', 'out', '--runs', 'run.gii', '--apertures', 'aps.mat', '--surf', 'surf'], /--hemisphere lh or rh \(it is srf\)/],
    [[...base, '--hemisphere', '../x'], /plain name/],
    [[...base, '--shards', '0'], /--shards must be a whole number/],
    [[...base, '--shards', '1.5'], /--shards must be a whole number/],
    [[...base, '--cache-dir', 'x'], /--cache-dir only applies to download-models/],
    [['self-check', 'extra'], /self-check does not accept arguments/],
    [[...base, '--norm'], /Unknown option '--norm'/],
    [[...base, '--hrf', 'fit.mat'], /^Error: fit\.mat: SamSrf reads a subject HRF fit from a file named hrf_\*\.mat\.$/],
    [[...base, '--hrf', 'hrf_fit.txt'], /hrf_fit\.txt: SamSrf reads a subject HRF fit from a file named hrf_\*\.mat/],
    [['cf', 'm.json', 'out', '--runs', 'lh_a.gii', '--seed', 's.label', '--template', 't.gii', '--hrf', 'hrf_fit.mat'], /--hrf applies to prf and rc/],
  ];
  for (const [argv, message] of cases) assert.throws(() => parseCommandLine(argv), message, argv.join(' '));
});

test('main prints help and version, and download-models installs nothing', async () => {
  const help = await run(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /^Usage: samsrf prf\|rc\|cf MODEL\.json OUTPUT_DIR --runs/);
  const version = await run(['--version']);
  assert.match(version.stdout, /^samsrf \d+\.\d+\.\d{8} \(SamSrf port core \d+\.\d+\.\d+\)\n$/);
  const models = await run(['download-models', '--cache-dir', 'models']);
  assert.equal(models.code, 0);
  assert.match(models.stdout, /0 model files: SamSrf has nothing to install in models/);
});

test('self-check recovers a known pRF and reports the runtime as JSON', () => {
  const result = spawnSync(process.execPath, [BIN, 'self-check'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.executable, process.execPath);
  assert.equal(report.node, process.version);
  assert.equal(report.samsrf, JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
  assert.deepEqual({ ...report.selfCheck, r2: Math.round(report.selfCheck.r2 * 1e6) / 1e6 }, { r2: 1, x0: 0.5, y0: 0, sigma: 0.25, maps: 8 });
});

test('errors exit 1 with a message naming the file', async (t) => {
  const work = scratch(t);
  const model = join(work, 'rc.json');
  writeFileSync(model, JSON.stringify(MODELS.rc));
  const broken = join(work, 'lh_broken.gii');
  writeFileSync(broken, 'not a GIfTI');
  const args = ['--runs', broken, '--apertures', join(work, 'aps.mat')];

  const unreadable = await run(['rc', model, join(work, 'out'), ...args]);
  assert.equal(unreadable.code, 1);
  assert.ok(unreadable.stderr.includes(`${broken}: `), unreadable.stderr);
  assert.equal(unreadable.stdout, '');
  assert.equal(existsSync(join(work, 'out')), false, 'a failed run creates no output directory');

  const badModel = join(work, 'bad.json');
  writeFileSync(badModel, '{"Name": ');
  const notJson = await run(['rc', badModel, join(work, 'out2'), ...args]);
  assert.equal(notJson.code, 1);
  assert.match(notJson.stderr, new RegExp(`^${badModel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: not a JSON model file`));

  const before = readdirSync(work).sort();
  const occupied = await run(['rc', model, work, ...args]);
  assert.equal(occupied.code, 1);
  assert.match(occupied.stderr, /must be new or empty/);
  assert.deepEqual(readdirSync(work).sort(), before);

  const usage = spawnSync(process.execPath, [BIN, 'rc'], { encoding: 'utf8' });
  assert.equal(usage.status, 1);
  assert.match(usage.stderr, /Give rc a model file and an output directory/);
});

test('the CLI applies and records the selected legacy export convention', async t => {
  const work = scratch(t);
  const modelPath = join(work, 'model.json');
  const apertures = join(work, 'aps.mat');
  const runPath = join(work, 'lh_run.gii');
  const model = {
    ...MODELS.prf, Name: 'Legacy', Hrf: 1, Polar_Search_Space: false,
    Param1: [3], Param2: [4], Param3: [2], Coarse_Fit_Only: true,
  };
  writeFileSync(apertures, matFile({ ApFrm: { dims: [2, 2, 4], data: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] } }));
  writeFileSync(runPath, giftiRun([[1, 2, 4, 3]]));
  for (const [convention, eccentricity] of [['samsrf-10.4', 5], ['samsrfx-10.003', 4.5]]) {
    writeFileSync(modelPath, JSON.stringify({ ...model, Export_Convention: convention }));
    const output = join(work, convention);
    const result = await run(['prf', modelPath, output, '--runs', runPath, '--apertures', apertures, '--no-normalise']);
    assert.equal(result.code, 0, result.stderr);
    const actual = readGifti(readFileSync(join(output, 'lh_Legacy_CrsFit_ecc.gii'))).arrays[0].data;
    assert.deepEqual(Array.from(actual), [eccentricity]);
    const provenance = JSON.parse(readFileSync(join(output, 'lh_Legacy_CrsFit_provenance.json')));
    assert.equal(provenance.exportConvention, convention);
  }
});

test('a single-precision rc run writes the in-process single job and refuses single 2D fits', async t => {
  const work = scratch(t);
  const modelPath = join(work, 'model.json');
  const apertures = join(work, 'aps.mat');
  const runPath = join(work, 'lh_run.gii');
  const model = { Name: 'Single', Scaling_Factor: 2, TR: 1, Hrf: 1, Aperture_File: 'aps', Data_Precision: 'single' };
  writeFileSync(apertures, matFile({ ApFrm: { dims: [2, 2, 6], data: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0] } }));
  // One course follows pixel 2; another is constant, which MATLAB's rank rule handles.
  writeFileSync(runPath, giftiRun([[0.1, 0.9, 0.2, 0.1, 0.05, 0.1], [3, 3, 3, 3, 3, 3]]));
  writeFileSync(modelPath, JSON.stringify(model));
  const output = join(work, 'out');
  const result = await run(['rc', modelPath, output, '--runs', runPath, '--apertures', apertures, '--no-normalise']);
  assert.equal(result.code, 0, result.stderr);
  const job = createJob(analysisSpec(readAnalysisInputs({ runs: [runPath], apertures, normalise: 'none', precision: 'single' }), 'rc', model));
  let expected;
  try {
    expected = exportGiis(runJob(job).maps, `lh_${job.modelName}${job.outSuffix}`);
  } finally {
    job.free();
  }
  for (const { name, bytes } of expected) assert.ok(Buffer.from(bytes).equals(readFileSync(join(output, name))), name);
  assert.equal(JSON.parse(readFileSync(join(output, 'lh_Single_Rcp_provenance.json'), 'utf8')).model.Data_Precision, 'single');
  const fit = { ...model, Prf_Function: '@(P,ApWidth)prf_gaussian_rf(P(1),P(2),P(3),ApWidth)', Param_Names: ['x0', 'y0', 'Sigma'], Scaled_Param: [1, 1, 1], SeedPar_Function: '@(V)[V(2:3);V(4)]' };
  writeFileSync(modelPath, JSON.stringify(fit));
  const refused = await run(['rc', modelPath, join(work, 'refused'), '--runs', runPath, '--apertures', apertures, '--no-normalise']);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /Data_Precision=single with a Prf_Function fit/);
});

test('a short rc run writes the GIfTIs an in-process job writes', { skip: !dir && 'set SAMSRF_WEBAPP_EXAMPLE_DIR' }, async (t) => {
  const work = scratch(t);
  const model = join(work, 'rc.json');
  writeFileSync(model, JSON.stringify(MODELS.rc));
  const [header, , ...rows] = readFileSync(join(dir, 'lh.V123.label'), 'utf8').split('\n');
  const roi = join(work, 'lh.small.label');
  writeFileSync(roi, `${[header, '64', ...rows.slice(0, 64)].join('\n')}\n`);
  const runs = [1, 2].map((index) => join(dir, `lh_uBars${index}.gii`));
  const inputs = { roi, apertures: join(dir, 'aps_Bars.mat') };
  const output = join(work, 'out');

  const result = spawnSync(process.execPath, [BIN, 'rc', model, output, '--runs', ...runs, '--roi', roi, '--apertures', inputs.apertures, '--shards', '2'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `${output}\n`);
  assert.match(result.stderr, /Analysing 64 vertices in 2 shards/);

  const job = createJob(analysisSpec(readAnalysisInputs({ runs, ...inputs }), 'rc', MODELS.rc));
  let expected;
  try {
    expected = exportGiis(runJob(job).maps, `lh_${job.modelName}${job.outSuffix}`);
  } finally {
    job.free();
  }
  assert.deepEqual(readdirSync(output).sort(), [...expected.map(({ name }) => name), 'lh_pRF_Rcp_provenance.json'].sort());
  for (const { name, bytes } of expected) assert.ok(Buffer.from(bytes).equals(readFileSync(join(output, name))), name);
  const provenance = JSON.parse(readFileSync(join(output, 'lh_pRF_Rcp_provenance.json'), 'utf8'));
  assert.equal(provenance.analysedVertices, 64);
  assert.deepEqual(provenance.model, MODELS.rc);
  assert.deepEqual(provenance.inputs.map(({ role }) => role), ['run', 'run', 'roi', 'apertures']);
  assert.match(provenance.inputs[0].sha256, /^[0-9a-f]{64}$/);
});

test('CLI reference models preprocess, shard and record the selected arithmetic', async t => {
  const work = scratch(t);
  const runPath = join(work, 'lh_run.gii');
  const apertures = join(work, 'aps.mat');
  const modelPath = join(work, 'model.json');
  writeFileSync(runPath, giftiRun(Array.from({ length: 3 }, (_, v) => Array.from({ length: 16 }, (_, n) => Math.sin(n + v) + n / 13))));
  writeFileSync(apertures, matFile({ ApFrm: { dims: [2, 2, 16], data: Array.from({ length: 64 }, (_, n) => Number(n % 5 === 0)) } }));
  for (const reference of ['current', 'matlab-amd', 'matlab-intel']) {
    const model = { Name: 'Reference', Scaling_Factor: 1, TR: 1, Hrf: 1, Aperture_File: 'aps', Arithmetic_Reference: reference };
    writeFileSync(modelPath, JSON.stringify(model));
    const output = join(work, reference);
    const actual = await run(['rc', modelPath, output, '--runs', runPath, '--apertures', apertures, '--shards', '2']);
    assert.equal(actual.code, 0, actual.stderr);
    const inputs = readAnalysisInputs({ runs: [runPath], apertures, arithmeticReference: reference });
    const job = createJob(analysisSpec(inputs, 'rc', model));
    try {
      const expected = exportGiis(runJob(job).maps, 'lh_Reference_Rcp');
      for (const { name, bytes } of expected) assert.deepEqual(readFileSync(join(output, name)), Buffer.from(bytes));
    } finally { job.free(); }
    const provenance = JSON.parse(readFileSync(join(output, 'lh_Reference_Rcp_provenance.json')));
    assert.equal(provenance.arithmeticReference, reference);
    assert.equal(provenance.model.Arithmetic_Reference, reference);
  }
});

// An old-school subject HRF fit and a small dataset for the two analyses that take one.
function subjectHrfCase(work) {
  const paths = { run: join(work, 'lh_run.gii'), apertures: join(work, 'aps.mat'), fit: join(work, 'hrf_subject.mat'), model: join(work, 'model.json') };
  const volumes = 60;
  const fP = [5.5, 15.5, 5, 2];
  // Pixel p (column-major in a 2 x 2 frame) is on in volumes n with (n + 3p) % 8 < 2; vertex v follows pixel v through the subject kernel.
  const pixel = (p) => Float64Array.from({ length: volumes }, (_, n) => Number((n + 3 * p) % 8 < 2));
  const kernel = hrf.oldSchool(1, fP);
  const courses = [0, 1, 2].map((v) => Array.from(hrf.convolve(pixel(v), kernel), (value, n) => value + 0.05 * Math.sin(7 * n + v)));
  const frames = Array.from({ length: volumes }, (_, n) => [0, 1, 2, 3].map((p) => pixel(p)[n])).flat();
  writeFileSync(paths.run, giftiRun(courses));
  writeFileSync(paths.apertures, matFile({ ApFrm: { dims: [2, 2, volumes], data: frames } }));
  writeFileSync(paths.fit, matFile({ fP: { dims: [1, 4], data: fP } }));
  const models = {
    rc: { Name: 'Subject', Scaling_Factor: 1, TR: 1, Hrf: 'hrf_subject', Aperture_File: 'aps' },
    prf: {
      ...MODELS.prf, Name: 'Subject', Hrf: 'hrf_subject', TR: 1, Aperture_File: 'aps', Polar_Search_Space: false,
      Param1: [-0.5, 0.5], Param2: [-0.5, 0.5], Param3: [0.5, 1], Coarse_Fit_Only: true,
    },
  };
  return { paths, models };
}

// The job the web app's engine builds (apps/samsrf/src/engine.js): the kernel hrf.oldSchool(TR, fP) as spec.hrf.
function appStyleFiles(kind, model, paths) {
  const spec = analysisSpec(readAnalysisInputs({ runs: [paths.run], apertures: paths.apertures }), kind, model);
  assert.equal(spec.hrf, undefined, 'no fit was read');
  spec.hrf = hrf.oldSchool(model.TR, readOldSchoolHrf(readFileSync(paths.fit)));
  const job = createJob(spec);
  try {
    return exportGiis(runJob(job).maps, `lh_${job.modelName}${job.outSuffix}`);
  } finally {
    job.free();
  }
}

test('--hrf runs prf and rc on the subject HRF fit the model names, byte for byte as the app builds the job', async t => {
  const work = scratch(t);
  const { paths, models } = subjectHrfCase(work);
  for (const kind of ['rc', 'prf']) {
    writeFileSync(paths.model, JSON.stringify(models[kind]));
    for (const shards of ['1', '2']) {
      const output = join(work, `${kind}-${shards}`);
      const result = await run([kind, paths.model, output, '--runs', paths.run, '--apertures', paths.apertures, '--hrf', paths.fit, '--shards', shards]);
      assert.equal(result.code, 0, result.stderr);
      const expected = appStyleFiles(kind, models[kind], paths);
      const prefix = `lh_${kind === 'rc' ? 'Subject_Rcp' : 'Subject_CrsFit'}`;
      assert.deepEqual(readdirSync(output).sort(), [...expected.map(({ name }) => name), `${prefix}_provenance.json`].sort());
      for (const { name, bytes } of expected) assert.ok(Buffer.from(bytes).equals(readFileSync(join(output, name))), `${kind} ${shards}: ${name}`);
      const provenance = JSON.parse(readFileSync(join(output, `${prefix}_provenance.json`), 'utf8'));
      assert.equal(provenance.model.Hrf, 'hrf_subject');
      if (kind === 'prf') assert.ok(readGifti(readFileSync(join(output, `${prefix}_r^2.gii`))).arrays[0].data.every((value) => value > 0.8), 'the subject kernel fits');
      assert.deepEqual(provenance.inputs.at(-1).role, 'subjectHrf');
      assert.equal(provenance.inputs.at(-1).path, paths.fit);
    }
  }
  // The fit is used: the same pRF model on the SPM canonical HRF gives other maps.
  writeFileSync(paths.model, JSON.stringify({ ...models.prf, Hrf: 0 }));
  const canonical = join(work, 'canonical');
  assert.equal((await run(['prf', paths.model, canonical, '--runs', paths.run, '--apertures', paths.apertures])).code, 0);
  const maps = (folder) => Object.fromEntries(readdirSync(folder).filter((name) => name.endsWith('.gii')).map((name) => [name, Array.from(readGifti(readFileSync(join(folder, name))).arrays[0].data)]));
  assert.notDeepEqual(maps(canonical), maps(join(work, 'prf-1')));
});

test('a subject HRF fit that is missing, malformed or not the one the model names stops the run before any output', async t => {
  const work = scratch(t);
  const { paths, models } = subjectHrfCase(work);
  const noFp = join(work, 'hrf_nofp.mat');
  writeFileSync(noFp, matFile({ ApFrm: { dims: [1, 4], data: [1, 2, 3, 4] } }));
  const shortFp = join(work, 'hrf_short.mat');
  writeFileSync(shortFp, matFile({ fP: { dims: [1, 3], data: [5.5, 15.5, 5] } }));
  const text = join(work, 'hrf_text.mat');
  writeFileSync(text, 'not a MAT file');
  const missing = join(work, 'hrf_missing.mat');
  const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const cases = [
    [{ Hrf: 'hrf_missing' }, missing, new RegExp(`(?:^|\\n)${escape(missing)}: no such subject HRF fit file\\.\\n$`)],
    [{ Hrf: 'hrf_text' }, text, new RegExp(`(?:^|\\n)${escape(text)}: `)],
    [{ Hrf: 'hrf_nofp' }, noFp, new RegExp(`(?:^|\\n)${escape(noFp)}: .*HRF file has no numeric fP variable`)],
    [{ Hrf: 'hrf_short' }, shortFp, new RegExp(`(?:^|\\n)${escape(shortFp)}: .*fP has 3 values; an old-school HRF has 4`)],
    [{}, null, new RegExp(`(?:^|\\n)${escape(paths.model)}: Hrf hrf_subject names a subject HRF fit: give it with --hrf hrf_subject\\.mat\\.\\n$`)],
    [{ Hrf: 0 }, paths.fit, new RegExp(`(?:^|\\n)${escape(paths.model)}: --hrf gives a subject HRF fit, but the model's Hrf is 0: set Hrf to "hrf_subject" to use it\\.\\n$`)],
    [{ Hrf: 'hrf_other' }, paths.fit, new RegExp(`(?:^|\\n)${escape(paths.model)}: Hrf hrf_other names hrf_other\\.mat, but --hrf gives hrf_subject\\.mat\\.\\n$`)],
  ];
  for (const kind of ['rc', 'prf']) {
    for (const [change, fit, message] of cases) {
      writeFileSync(paths.model, JSON.stringify({ ...models[kind], ...change }));
      const output = join(work, 'out');
      const result = await run([kind, paths.model, output, '--runs', paths.run, '--apertures', paths.apertures, ...(fit ? ['--hrf', fit] : [])]);
      assert.equal(result.code, 1, `${kind} ${JSON.stringify(change)}`);
      assert.match(result.stderr, message);
      assert.equal(result.stdout, '');
      assert.equal(existsSync(output), false, 'a refused run creates no output directory');
    }
  }
});

test('a short rc run on the example with --hrf writes the GIfTIs the app-built job writes', { skip: !dir && 'set SAMSRF_WEBAPP_EXAMPLE_DIR' }, async (t) => {
  const work = scratch(t);
  const model = { ...MODELS.rc, Hrf: 'hrf_subject' };
  const paths = { model: join(work, 'rc.json'), fit: join(work, 'hrf_subject.mat'), run: join(dir, 'lh_uBars1.gii'), apertures: join(dir, 'aps_Bars.mat') };
  writeFileSync(paths.model, JSON.stringify(model));
  writeFileSync(paths.fit, matFile({ fP: { dims: [1, 4], data: [5.5, 15.5, 5, 2] } }));
  const [header, , ...rows] = readFileSync(join(dir, 'lh.V123.label'), 'utf8').split('\n');
  const roi = join(work, 'lh.small.label');
  writeFileSync(roi, `${[header, '64', ...rows.slice(0, 64)].join('\n')}\n`);
  const output = join(work, 'out');
  const result = await run(['rc', paths.model, output, '--runs', paths.run, '--roi', roi, '--apertures', paths.apertures, '--hrf', paths.fit, '--shards', '2']);
  assert.equal(result.code, 0, result.stderr);
  const spec = analysisSpec(readAnalysisInputs({ runs: [paths.run], roi, apertures: paths.apertures }), 'rc', model);
  spec.hrf = hrf.oldSchool(model.TR, readOldSchoolHrf(readFileSync(paths.fit)));
  const job = createJob(spec);
  let expected;
  try {
    expected = exportGiis(runJob(job).maps, `lh_${job.modelName}${job.outSuffix}`);
  } finally {
    job.free();
  }
  for (const { name, bytes } of expected) assert.ok(Buffer.from(bytes).equals(readFileSync(join(output, name))), name);
  const r2 = readGifti(readFileSync(join(output, 'lh_pRF_Rcp_r^2.gii'))).arrays[0].data;
  assert.ok(r2.filter((value) => value > 0).length > 10, 'reverse correlation finds profiles through the subject kernel');
});
