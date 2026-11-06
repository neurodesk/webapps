import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { hemisphereOf, main, parseCommandLine } from '../src/cli.js';
import { analysisSpec, createJob, exportGiis, readAnalysisInputs, readGifti, runJob } from '../src/node.js';
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
