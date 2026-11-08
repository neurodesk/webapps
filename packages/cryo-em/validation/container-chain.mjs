#!/usr/bin/env node
// Runs the commands relionCommand() generates for a whole chain, import to
// postprocess, in the relion container on the CPU, the way the compute server
// runs a job: one container per step, the project mounted at /project as the
// working directory, the data root read-only at /data/<root>, MPI steps under
// `mpirun --bind-to none -np N`, `then` steps after the main program, stopping
// at the first failure. After each job it checks RELION_JOB_EXIT_SUCCESS and
// every required output of relionOutputs(), and feeds the outputs to the next
// job as the app would.
//
// This checks arguments and plumbing on a subset of the tutorial movies with
// reduced settings. It is not ADR-0004's GPU reconstruction gate.
//
//   node packages/cryo-em/validation/container-chain.mjs \
//     --movies <dir holding Movies/ of the RELION tutorial> --project <empty dir>
//
// Options: --image (relion:5.1.1), --pattern (20170629_0002?_frameImage.tiff),
// --cpus (all cores), --record <file> (JSON of the run). Rerunning on the same
// project skips jobs that already succeeded.

import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { RELION_DEFINITION, jobTypeDirectory, relionCommand, relionOutputs, validateRelionSpec } from '../src/spec.js';

const { values: args } = parseArgs({
  options: {
    image: { type: 'string', default: 'relion:5.1.1' },
    movies: { type: 'string' },
    project: { type: 'string' },
    pattern: { type: 'string', default: '20170629_0002?_frameImage.tiff' },
    cpus: { type: 'string', default: String(availableParallelism()) },
    record: { type: 'string' },
  },
});
if (!args.movies || !args.project) throw new Error('--movies and --project are required');

const PROJECT_ID = '0123456789abcdef0123456789abcdef';
const ROOT = 'examples';
// The tutorial directory is the data root's `relion-tutorial`.
const ROOT_MOUNT = `/data/${ROOT}/relion-tutorial`;
const profile = { cpus: Number(args.cpus), gpus: 0 };
const project = resolve(args.project);
const moviesParent = resolve(args.movies);

// STAR helpers: the rows of a data block's loop, as objects keyed by label.
function starTable(path, block) {
  const lines = readFileSync(path, 'utf8').split('\n');
  const start = lines.findIndex(line => line.trim() === `data_${block}`);
  if (start < 0) return null;
  const labels = [];
  const rows = [];
  let index = start + 1;
  while (index < lines.length && !lines[index].trim().startsWith('_') && !lines[index].trim().startsWith('data_')) index += 1;
  for (; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line.startsWith('data_')) break;
    if (line.startsWith('_')) {
      labels.push(line.split(/\s+/)[0].slice(1));
    } else if (line !== '' && !line.startsWith('#') && line !== 'loop_') {
      const words = line.split(/\s+/);
      rows.push(Object.fromEntries(labels.map((label, at) => [label, words[at]])));
    }
  }
  return { labels, rows };
}

// A data block of label/value pairs (no loop).
function starPairs(path, block) {
  const table = starTable(path, block);
  if (table === null) return null;
  const text = readFileSync(path, 'utf8');
  const section = text.split(`data_${block}`)[1].split(/\ndata_/)[0];
  return Object.fromEntries(section.split('\n').map(line => line.trim()).filter(line => line.startsWith('_')).map(line => {
    const [label, ...value] = line.split(/\s+/);
    return [label.slice(1), value.join(' ')];
  }));
}

const counts = {};
const records = [];
let jobCounter = 0;

function shellQuote(word) {
  return /^[A-Za-z0-9_./=:@%+-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;
}

function dockerStep(argv, ranks, directory) {
  const launcher = ranks > 1 ? ['mpirun', '--bind-to', 'none', '-np', String(ranks)] : [];
  const docker = [
    'run', '--rm', '-u', `${process.getuid()}:${process.getgid()}`, '-e', 'HOME=/tmp', '--shm-size', '8g',
    '-v', `${project}:/project:rw`, '-v', `${moviesParent}:${ROOT_MOUNT}:ro`, '-w', '/project',
    args.image, ...launcher, ...argv,
  ];
  const out = openSync(join(project, directory, 'run.out'), 'a');
  const err = openSync(join(project, directory, 'run.err'), 'a');
  const started = Date.now();
  const result = spawnSync('docker', docker, { stdio: ['ignore', out, err] });
  closeSync(out);
  closeSync(err);
  return { line: [...launcher, ...argv].map(shellQuote).join(' '), status: result.status, seconds: (Date.now() - started) / 1000 };
}

async function runJob(label, command, inputs, options = {}) {
  jobCounter += 1;
  const spec = { tool: 'relion', command, project: PROJECT_ID, inputs, options };
  const validated = validateRelionSpec(spec, { parts: [], profile });
  const directory = `${jobTypeDirectory(command)}/job${String(jobCounter).padStart(3, '0')}`;
  const result = relionCommand(validated, { directory, profile });
  const outputs = relionOutputs(validated);
  const required = outputs.filter(output => output.required).map(output => `${directory}/${output.path}`);
  const done = () => existsSync(join(project, directory, 'RELION_JOB_EXIT_SUCCESS')) && required.every(path => existsSync(join(project, path)));
  const steps = [{ argv: [result.program, ...result.args], ranks: result.mpiRanks }, ...result.then.map(step => ({ argv: [step.program, ...step.args], ranks: 1 }))];
  const record = { label, command, directory, spec, launch: { mpiRanks: result.mpiRanks, threads: result.threads, gpus: result.gpus }, steps: [], seconds: 0, reused: false };
  if (done()) {
    record.reused = true;
    record.steps = steps.map(step => ({ line: [...(step.ranks > 1 ? ['mpirun', '--bind-to', 'none', '-np', String(step.ranks)] : []), ...step.argv].map(shellQuote).join(' ') }));
    console.log(`= ${label}: ${directory} already succeeded`);
  } else {
    await mkdir(join(project, directory), { recursive: true });
    console.log(`> ${label}: ${directory} (${result.mpiRanks} rank(s) x ${result.threads} thread(s))`);
    for (const step of steps) {
      console.log(`  $ ${step.argv[0]} ...`);
      const ran = dockerStep(step.argv, step.ranks, directory);
      record.steps.push(ran);
      record.seconds += ran.seconds;
      if (ran.status !== 0) {
        records.push(record);
        throw new Error(`${label}: ${step.argv[0]} exited with ${ran.status} after ${ran.seconds.toFixed(0)} s; see ${join(project, directory, 'run.err')}`);
      }
    }
    console.log(`  ${record.seconds.toFixed(0)} s`);
  }
  if (!existsSync(join(project, directory, 'RELION_JOB_EXIT_SUCCESS'))) throw new Error(`${label}: no RELION_JOB_EXIT_SUCCESS in ${directory}`);
  const missing = required.filter(path => !existsSync(join(project, path)));
  if (missing.length > 0) throw new Error(`${label}: required outputs missing: ${missing.join(', ')}`);
  record.outputs = outputs.map(output => ({ ...output, exists: existsSync(join(project, directory, output.path)) }));
  records.push(record);
  return { directory, validated };
}

function rowCount(path, block) {
  const table = starTable(join(project, path), block);
  if (table === null) throw new Error(`${path} has no data_${block}`);
  return table.rows.length;
}

async function main() {
  await mkdir(project, { recursive: true });
  const started = Date.now();

  // Reduced but realistic settings: the tutorial's acquisition, gain, LoG
  // diameters and box, fewer 2D classes and VDAM mini-batches. Refine3D runs
  // to convergence.
  const imp = await runJob('Import', 'import', { movies: { root: ROOT, path: 'relion-tutorial/Movies', pattern: args.pattern } }, { angpix: 0.885, kV: 200, Cs: 1.4 });
  counts.movies = rowCount(`${imp.directory}/movies.star`, 'movies');

  const mc = await runJob('MotionCorr', 'motioncorr', { movies: `${imp.directory}/movies.star`, gain: { root: ROOT, path: 'relion-tutorial/Movies/gain.mrc' } }, { dosePerFrame: 1.277, patchX: 5, patchY: 5, gainFlip: 1 });
  counts.micrographs = rowCount(`${mc.directory}/corrected_micrographs.star`, 'micrographs');

  const ctf = await runJob('CtfFind', 'ctffind', { micrographs: `${mc.directory}/corrected_micrographs.star` });
  counts.ctfMicrographs = rowCount(`${ctf.directory}/micrographs_ctf.star`, 'micrographs');

  const pick = await runJob('AutoPick (LoG)', 'autopick', { micrographs: `${ctf.directory}/micrographs_ctf.star` }, { logDiamMin: 150, logDiamMax: 180, logUpperThreshold: 5 });

  const ext = await runJob('Extract', 'extract', { micrographs: `${ctf.directory}/micrographs_ctf.star`, coordinates: `${pick.directory}/autopick.star` }, { extractSize: 256, doRescale: true, rescale: 64 });
  counts.extracted = rowCount(`${ext.directory}/particles.star`, 'particles');

  const class2dOptions = { nrClasses: 20, nrIterGrad: 100, particleDiameter: 200 };
  const c2d = await runJob('Class2D (VDAM)', 'class2d', { particles: `${ext.directory}/particles.star` }, class2dOptions);
  const iteration = String(class2dOptions.nrIterGrad).padStart(3, '0');

  const ranker = await runJob('Select (class ranker)', 'select', { optimiser: `${c2d.directory}/run_it${iteration}_optimiser.star` }, { mode: 'ranker', minScore: 0.25 });
  counts.rankerParticles = rowCount(`${ranker.directory}/particles.star`, 'particles');

  // The classes the ranker kept, selected again by number: the same particles.
  const averages = starTable(join(project, ranker.directory, 'class_averages.star'), 'model_classes') ?? starTable(join(project, ranker.directory, 'class_averages.star'), '');
  const classes = [...new Set(averages.rows.map(row => Number(row.rlnReferenceImage.split('@')[0])))].sort((a, b) => a - b);
  counts.rankerClasses = classes;
  const byNumber = await runJob('Select (classes)', 'select', { particles: `${c2d.directory}/run_it${iteration}_data.star` }, { mode: 'classes', classes });
  counts.classesParticles = rowCount(`${byNumber.directory}/particles.star`, 'particles');
  const names = path => starTable(join(project, path), 'particles').rows.map(row => row.rlnImageName).sort();
  const sameParticles = JSON.stringify(names(`${ranker.directory}/particles.star`)) === JSON.stringify(names(`${byNumber.directory}/particles.star`));
  if (!sameParticles) throw new Error('classes mode did not select the particles of the ranker\'s classes');
  counts.classesModeMatchesRanker = sameParticles;

  const ini = await runJob('InitialModel (VDAM)', 'initialmodel', { particles: `${ranker.directory}/particles.star` }, { nrIter: 50, sym: 'D2', particleDiameter: 200 });

  const ref = await runJob('Refine3D', 'refine3d', { particles: `${ranker.directory}/particles.star`, reference: `${ini.directory}/initial_model.mrc` }, { sym: 'D2', particleDiameter: 200 });
  const model = starPairs(join(project, ref.directory, 'run_model.star'), 'model_general');
  counts.refineResolution = Number(model.rlnCurrentResolution);
  const iterations = readFileSync(join(project, ref.directory, 'run.out'), 'utf8').match(/Auto-refine: Iteration= *\d+/g) ?? [];
  counts.refineIterations = iterations.length;

  const mask = await runJob('MaskCreate', 'maskcreate', { map: `${ref.directory}/run_class001.mrc` }, { inimaskThreshold: 0.01, extendInimask: 2, widthMaskEdge: 3 });

  const post = await runJob('PostProcess', 'postprocess', { halfMap: `${ref.directory}/run_half1_class001_unfil.mrc`, mask: `${mask.directory}/mask.mrc` });
  const general = starPairs(join(project, post.directory, 'postprocess.star'), 'general');
  counts.finalResolution = Number(general.rlnFinalResolution);
  counts.bfactor = Number(general.rlnBfactorUsedForSharpening);

  const version = spawnSync('docker', ['run', '--rm', args.image, 'relion_refine', '--version'], { encoding: 'utf8' }).stdout.trim().split('\n')[0];
  const summary = {
    relion: version,
    table: RELION_DEFINITION.version,
    image: args.image,
    profile,
    pattern: args.pattern,
    totalSeconds: records.reduce((sum, record) => sum + record.seconds, 0),
    wallSeconds: (Date.now() - started) / 1000,
    counts,
    jobs: records,
  };
  if (args.record) await writeFile(args.record, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`\n${version}`);
  for (const record of records) console.log(`${record.label.padEnd(24)} ${record.directory.padEnd(20)} ${record.reused ? 'reused' : `${record.seconds.toFixed(0)} s`}`);
  console.log(`\nMovies ${counts.movies}, micrographs ${counts.micrographs}, extracted particles ${counts.extracted}`);
  console.log(`Ranker kept classes ${classes.join(', ')}: ${counts.rankerParticles} particles (classes mode: ${counts.classesParticles}, same particles: ${sameParticles})`);
  console.log(`Refine3D: ${counts.refineIterations} iterations, ${counts.refineResolution} A`);
  console.log(`PostProcess final resolution: ${counts.finalResolution} A (B-factor ${counts.bfactor})`);
}

await main();
