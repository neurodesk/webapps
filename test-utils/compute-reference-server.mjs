// Node reference implementation of the remote compute protocol v1 with the
// simulated nesvor, sct and relion tools. Used by browser tests, the desktop
// workflow and the protocol conformance tests. With `singleOwner` it also
// serves the HPC features: projects, data roots and the relion tool.
// See docs/architecture/remote-compute-protocol.md.
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { RELION_COMMANDS, RELION_DEFINITION, jobTypeDirectory, parseRelionLogLine, relionCommand, resolveInputPaths, validateRelionSpec } from '../packages/cryo-em/src/spec.js';
import { canonicalRoots, compareBytes, isInside, listEntries, matchPattern, resolveFile } from './data-roots.mjs';
import { checkReferences, isMrc, launchLines, missingOutputs, syntheticLog, writeJobEnd, writeOutputs } from './relion-simulator.mjs';
import { isNifti1, readVolume, writeFloat32Volume } from './nifti-fixture.mjs';
import { validateSctSpec, sctArgv, SCT_IMAGE, SCT_VERSION, SCT_COMMANDS } from '../apps/spinalcordtoolbox/web/js/app/analysis-spec.js';
import { validateNesvorSpec, nesvorArgv } from '../apps/nesvor/src/spec.js';

export const REFERENCE_VERSION = '0.1.20260921';
export const NESVOR_IMAGE = 'vnmd/nesvor_0.5.0@sha256:4a9b346297bd5c10af4047745b6fa82f2912e06c8fecaab615f2adcb32599f64';
// The relion image is pinned by digest once the multi-arch rebuild is published.
export const RELION_IMAGE = 'vnmd/relion_5.1.1';
export const SESSION_IDLE_DAYS = 14;
const SESSION_IDLE_MS = SESSION_IDLE_DAYS * 24 * 60 * 60 * 1000;
const SINGLE_OWNER = 'single-owner';
const LOCAL_PROFILE = 'local';
const ACTIVE = ['queued', 'running', 'cancelling'];
const ALWAYS_ALLOWED = ['https://webapps.neurodesk.org', 'https://neurodesk.github.io'];
const STAGES = [
  ['Data loading starts ...', 'Loading stacks', 0.02],
  ['Registration starts ...', 'Motion correction', 0.25],
  ['Reconsturction starts ...', 'Reconstruction', 0.4],
  ['NeSVoR training starts.', 'Reconstruction', 0.4],
];

function timestamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function logLine(level, message) {
  return `${timestamp()} [${level}] ${message}`;
}

function contentTypeOf(name) {
  const extension = name.includes('.') ? name.split('.').at(-1).toLowerCase() : '';
  const types = {
    json: 'application/json',
    star: 'text/plain',
    txt: 'text/plain',
    out: 'text/plain',
    err: 'text/plain',
    log: 'text/plain',
    sbatch: 'text/plain',
    png: 'image/png',
    pdf: 'application/pdf',
    eps: 'application/postscript',
    gz: 'application/gzip',
  };
  return types[extension] ?? 'application/octet-stream';
}

// The canonical `<project>/<Type>/jobNNN`, anchored to the canonical project
// directory: jobs write the project, so a symlink anywhere in `directory`
// could point outside it, and such a directory throws.
function jobDirOf(projectDir, directory) {
  const expected = join(realpathSync(projectDir), directory);
  if (realpathSync(expected) !== expected || !statSync(expected).isDirectory()) throw new Error(`${directory} is not a directory of its project`);
  return expected;
}

// Every regular file under a project job's directory, recursively, sorted by
// project-relative name. A symlink is listed only when its canonical target is
// a file inside the job directory.
function listJobFiles(projectDir, directory, maxDownloadBytes) {
  let jobDir;
  try {
    jobDir = jobDirOf(projectDir, directory);
  } catch {
    return [];
  }
  const outputs = [];
  const pending = [[jobDir, directory]];
  while (pending.length) {
    const [folder, prefix] = pending.pop();
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const name = `${prefix}/${entry.name}`;
      const path = join(folder, entry.name);
      if (entry.isDirectory()) {
        pending.push([path, name]);
        continue;
      }
      let target = path;
      if (entry.isSymbolicLink()) {
        try {
          target = realpathSync(path);
        } catch {
          continue;
        }
        if (!isInside(jobDir, target)) continue;
      }
      const stat = statSync(target);
      if (!stat.isFile()) continue;
      outputs.push({ name, bytes: stat.size, contentType: contentTypeOf(entry.name), download: stat.size <= maxDownloadBytes });
    }
  }
  return outputs.sort((a, b) => compareBytes(a.name, b.name));
}

function pad3(value) {
  return String(value).padStart(3, '0');
}

/**
 * Start the reference server. HPC options (protocol "HPC features"):
 * `singleOwner` maps every pairing to one owner and enables projects, data
 * roots and the relion tool; `dataRoots` is `{ id: absolutePath }`; `dataDir`
 * holds the projects (default: a temporary directory removed on close);
 * `maxDownloadBytes` marks larger project outputs `download: false`;
 * `localProfile` is the built-in `local` resource profile; `clock` returns
 * the time in milliseconds for session idle expiry.
 */
export function startReferenceServer({
  port = 0,
  host = '127.0.0.1',
  token = 'test-token',
  allowOrigins = [],
  stageDelayMs = 40,
  maxUploadBytes = 512 * 1024 * 1024,
  maxFiles = 40,
  singleOwner = false,
  dataRoots = {},
  dataDir = null,
  maxDownloadBytes = 2 * 1024 * 1024 * 1024,
  localProfile = { cpus: availableParallelism(), gpus: 0 },
  clock = Date.now,
} = {}) {
  const jobs = new Map();
  const sessions = new Map();
  const submissions = new Map();
  const projects = new Map();
  const roots = canonicalRoots(dataRoots);
  const ownsDataDir = !dataDir;
  if (dataDir) mkdirSync(dataDir, { recursive: true });
  const dataPath = realpathSync(dataDir ?? mkdtempSync(join(tmpdir(), 'nd-compute-reference-')));
  const projectsDir = join(dataPath, 'projects');
  mkdirSync(projectsDir, { recursive: true });
  let failNext = null;
  let running = null;
  let runningJob = Promise.resolve();
  let closed = false;
  const queue = [];

  const allowed = origin => {
    if (!origin) return true;
    if (ALWAYS_ALLOWED.includes(origin) || allowOrigins.includes(origin)) return true;
    return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  };

  const cors = (request, response) => {
    const origin = request.headers.origin;
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Vary', 'Origin');
    if (origin && allowed(origin)) {
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Idempotency-Key');
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      response.setHeader('Access-Control-Allow-Private-Network', 'true');
      response.setHeader('Access-Control-Max-Age', '600');
      response.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    }
    return !origin || allowed(origin);
  };

  const json = (response, status, payload) => {
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(payload));
  };
  const fail = (response, status, code, message) => json(response, status, { error: { code, message } });

  // Sessions are keyed by credential. In single-owner mode a credential idle
  // for SESSION_IDLE_DAYS is revoked; every use refreshes it.
  const ownerOf = request => {
    const header = request.headers.authorization || '';
    if (!header.startsWith('Bearer ')) return undefined;
    const credential = header.slice(7);
    const session = sessions.get(credential);
    if (!session) return undefined;
    if (singleOwner && clock() - session.lastUsed > SESSION_IDLE_MS) {
      sessions.delete(credential);
      return undefined;
    }
    session.lastUsed = clock();
    return session.owner;
  };

  const projectDirOf = id => join(projectsDir, id);

  const publicJob = job => ({
    id: job.id,
    tool: job.spec.tool,
    command: job.spec.command,
    status: job.status,
    position: job.status === 'queued' ? queue.indexOf(job) + (running ? 1 : 0) : 0,
    progress: job.progress,
    stage: job.stage,
    message: job.message,
    simulated: true,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    error: job.error,
    outputs: publicOutputs(job),
    project: job.project,
    directory: job.directory,
    dependsOn: job.dependsOn,
    scheduler: null,
  });

  // v1 outputs exist only after success; a project job lists its directory
  // once it has ended, whatever the outcome.
  const publicOutputs = job => {
    if (job.project) return ['succeeded', 'failed', 'cancelled'].includes(job.status) ? job.listing : [];
    if (job.status !== 'succeeded') return [];
    return job.outputs.map(({ name, bytes, contentType }) => ({ name, bytes: bytes.length, contentType }));
  };

  const emit = (job, event, data) => {
    job.events.push({ event, data });
    for (const listener of job.listeners) listener(event, data);
  };
  const log = (job, level, message) => {
    const line = logLine(level.toUpperCase(), message);
    job.log.push(line);
    job.message = message;
    emit(job, 'log', { line, level });
  };
  const progress = (job, fraction, stage) => {
    job.progress = fraction;
    job.stage = stage;
    emit(job, 'progress', { fraction, stage });
  };
  const setStatus = (job, status) => {
    job.status = status;
    emit(job, 'status', { status, position: publicJob(job).position });
  };
  const sleep = (job, ms) => new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    job.wake = () => { clearTimeout(timer); resolve(); };
  });

  const finish = (job, status, error = null) => {
    job.finishedAt = new Date().toISOString();
    job.error = error;
    if (job.project) job.listing = listJobFiles(projectDirOf(job.project), job.directory, maxDownloadBytes);
    setStatus(job, status);
    emit(job, 'done', publicJob(job));
    job.listeners.clear();
  };

  const runSct = async job => {
    const fileNames = Object.fromEntries(Object.entries(job.files).map(([role, bytes]) => [role, `${role}.nii${bytes[0] === 31 && bytes[1] === 139 ? '.gz' : ''}`]));
    log(job, 'info', `Simulated run of: ${sctArgv(job.validated, fileNames).join(' ')}`);
    log(job, 'warning', 'SIMULATED SCT artifacts; no scientific analysis was performed');
    const wantsFailure = failNext;
    failNext = null;
    await sleep(job, stageDelayMs * 8);
    if (job.cancelled) return finish(job, 'cancelled');
    if (wantsFailure) return finish(job, 'failed', { code: 'tool-failed', message: wantsFailure });
    job.outputs = job.spec.command === 'process_segmentation'
      ? [{ name: 'morphometry.csv', bytes: Buffer.from('Simulated,MEAN(area)\ntrue,0\n'), contentType: 'text/csv' }]
      : [
        { name: 'lesion_analysis.xlsx', bytes: Buffer.from('SIMULATED SCT spreadsheet placeholder\n'), contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
        { name: 'lesion_analysis.pkl', bytes: Buffer.from('SIMULATED SCT pickle placeholder\n'), contentType: 'application/octet-stream' },
        { name: fileNames.lesion.replace('lesion.', 'lesion_label.'), bytes: job.files.lesion, contentType: fileNames.lesion.endsWith('.gz') ? 'application/gzip' : 'application/octet-stream' },
      ];
    job.outputs.push({ name: 'log.txt', bytes: Buffer.from(`${job.log.join('\n')}\n`), contentType: 'text/plain' });
    progress(job, 1, 'Finished');
    finish(job, 'succeeded');
  };

  // The simulated relion tool: log the command lines, check every file the
  // inputs reference, replay RELION-format log lines, then write the outputs,
  // run.out, run.err and the exit marker (test-utils/relion-simulator.mjs).
  const runRelion = async job => {
    const context = {
      projectDir: projectDirOf(job.project),
      directory: job.directory,
      validated: job.validated,
      inputPaths: resolveInputPaths(job.validated, job.directory),
      dataRoots: roots,
    };
    const out = [];
    const err = [];
    const say = (level, line) => {
      out.push(line);
      if (level === 'error') err.push(line);
      log(job, level, line);
    };
    const end = (status, error = null, marker = null) => {
      try {
        writeJobEnd(context, { out, err, marker });
      } catch (writeError) {
        log(job, 'error', `Could not write the job's log: ${writeError.message}`);
      }
      finish(job, status, error);
    };
    const failed = message => end('failed', { code: 'tool-failed', message }, 'RELION_JOB_EXIT_FAILURE');
    const wantsFailure = failNext;
    failNext = null;
    try {
      const command = relionCommand(job.validated, { directory: job.directory, profile: localProfile });
      for (const line of launchLines(command)) say('info', `Simulated run of: ${line}`);
      say('warning', 'SIMULATED relion: no RELION program runs and every output is a placeholder');
      try {
        checkReferences(context);
      } catch (error) {
        say('error', `ERROR: ${error.message}`);
        return failed(error.message);
      }
      for (const line of syntheticLog(job.validated)) {
        if (job.cancelled) return end('cancelled');
        const parsed = parseRelionLogLine(job.validated, line);
        say(parsed.level, line);
        if (parsed.progress) progress(job, parsed.progress[0], parsed.progress[1]);
        await sleep(job, stageDelayMs);
      }
      if (job.cancelled) return end('cancelled');
      if (wantsFailure) {
        say('error', `ERROR: ${wantsFailure}`);
        return failed(`${command.program} exited with status 1`);
      }
      for (const line of writeOutputs(context)) say('info', line);
      const missing = missingOutputs(context);
      if (missing.length) {
        const message = `required outputs are missing: ${missing.join(', ')}`;
        say('error', `ERROR: ${message}`);
        return failed(message);
      }
      progress(job, 1, 'Finished');
      return end('succeeded', null, 'RELION_JOB_EXIT_SUCCESS');
    } catch (error) {
      say('error', `ERROR: ${error.message}`);
      return failed(error.message);
    }
  };

  const run = async job => {
    job.startedAt = new Date().toISOString();
    setStatus(job, 'running');
    if (job.spec.tool === 'sct') return runSct(job);
    if (job.spec.tool === 'relion') return runRelion(job);
    log(job, 'info', `Simulated run of: nesvor ${nesvorArgv(job.validated).join(' ')}`);
    const wantsFailure = failNext;
    failNext = null;
    for (const [line, stage, fraction] of STAGES) {
      if (job.cancelled) return finish(job, 'cancelled');
      log(job, 'info', line);
      progress(job, fraction, stage);
      await sleep(job, stageDelayMs);
    }
    const iterations = job.validated.options.iterations;
    for (const fractionDone of [0.5, 0.75, 0.9, 1]) {
      if (job.cancelled) return finish(job, 'cancelled');
      const iteration = Math.round(iterations * fractionDone);
      log(job, 'info', `     0:00:0${Math.round(fractionDone * 9)}            1 ${String(iteration).padStart(12)}    1.000e-01    5.000e-03`);
      progress(job, 0.4 + 0.5 * fractionDone, 'Reconstruction');
      await sleep(job, stageDelayMs);
    }
    if (job.cancelled) return finish(job, 'cancelled');
    if (wantsFailure) {
      log(job, 'error', `Unhandled exception:\n${wantsFailure}`);
      return finish(job, 'failed', { code: 'tool-failed', message: 'nesvor exited with status 1' });
    }
    log(job, 'info', 'Results saving starts ...');
    progress(job, 0.92, 'Sampling volume');
    try {
      const first = readVolume(job.files[job.validated.stacks[0].file]);
      const sum = new Float64Array(first.data);
      let count = 1;
      for (const stack of job.validated.stacks.slice(1)) {
        const volume = readVolume(job.files[stack.file]);
        if (volume.dims.join('x') !== first.dims.join('x')) {
          log(job, 'warning', `Skipping ${stack.file}: dimensions differ from the first stack`);
          continue;
        }
        for (let index = 0; index < sum.length; index += 1) sum[index] += volume.data[index];
        count += 1;
      }
      for (let index = 0; index < sum.length; index += 1) sum[index] /= count;
      const volume = writeFloat32Volume(first.header, sum);
      const result = Buffer.from(JSON.stringify({ simulated: true, stacks: job.validated.stacks.length, options: job.validated.options }, null, 2));
      log(job, 'info', "Command 'nesvor reconstruct' finished, overall time: 0.4 s");
      progress(job, 1, 'Finished');
      job.outputs = [
        { name: 'volume.nii.gz', bytes: volume, contentType: 'application/gzip' },
        { name: 'result.json', bytes: result, contentType: 'application/json' },
        { name: 'log.txt', bytes: Buffer.from(`${job.log.join('\n')}\n`), contentType: 'text/plain' },
      ];
      finish(job, 'succeeded');
    } catch (error) {
      log(job, 'error', error.message);
      finish(job, 'failed', { code: 'tool-failed', message: error.message });
    }
    return null;
  };

  const pump = () => {
    if (closed || running || !queue.length) return;
    running = queue.shift();
    for (const job of queue) emit(job, 'status', { status: 'queued', position: publicJob(job).position });
    runningJob = run(running).finally(() => {
      running = null;
      pump();
    });
  };

  const fingerprintOf = (validated, files) => JSON.stringify({ validated, files: Object.keys(files).sort().map(name => [name, createHash('sha256').update(files[name]).digest('hex')]) });

  const enqueue = (response, owner, scopedKey, fingerprint, fields) => {
    const job = {
      id: randomBytes(16).toString('hex'),
      owner,
      status: 'queued',
      progress: null,
      stage: null,
      message: null,
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      error: null,
      outputs: [],
      project: null,
      directory: null,
      dependsOn: [],
      listing: [],
      log: [],
      events: [],
      listeners: new Set(),
      cancelled: false,
      wake: null,
      ...fields,
    };
    jobs.set(job.id, job);
    submissions.set(scopedKey, { id: job.id, fingerprint });
    queue.push(job);
    json(response, 202, { id: job.id, status: 'queued', position: publicJob(job).position });
    pump();
    return job;
  };

  const replay = (response, previous, fingerprint) => {
    if (previous.fingerprint !== fingerprint) return fail(response, 409, 'conflict', 'Idempotency-Key was already used for different content');
    const existing = jobs.get(previous.id);
    if (!existing) return fail(response, 409, 'conflict', 'The original job has been deleted; use a new submission key');
    return json(response, 202, { id: existing.id, status: existing.status, position: publicJob(existing).position });
  };

  // Data-root inputs must resolve now; the job sees the roots again when it runs.
  const checkDataInputs = validated => {
    for (const [name, value] of Object.entries(validated.inputs)) {
      if (typeof value !== 'object' || 'part' in value) continue;
      const root = roots.get(value.root);
      if (!root) throw new Error(`inputs.${name}.root names an unknown data root`);
      try {
        if ('pattern' in value) matchPattern(root, value.path, value.pattern);
        else resolveFile(root, value.path);
      } catch (error) {
        throw new Error(`inputs.${name}: ${error.message}`);
      }
    }
  };

  // Each project path input must be a listed output of a succeeded job in the
  // same project; those jobs become the direct dependencies.
  const resolveDependencies = (project, validated) => {
    const dependsOn = [];
    for (const [name, value] of Object.entries(validated.inputs)) {
      if (typeof value !== 'string') continue;
      const directory = value.split('/').slice(0, 2).join('/');
      const source = project.jobIds.map(id => jobs.get(id)).find(job => job.directory === directory);
      const listed = source?.status === 'succeeded' && source.listing.some(output => output.name === value);
      if (!listed) throw new Error(`inputs.${name}: ${value} is not a listed output of a succeeded job in this project`);
      if (!dependsOn.includes(source.id)) dependsOn.push(source.id);
    }
    return dependsOn;
  };

  const submitRelion = (response, owner, scopedKey, spec, files) => {
    if (!singleOwner) return fail(response, 400, 'invalid-spec', 'The relion tool exists only on a server in single-owner mode');
    let validated;
    let dependsOn;
    let project;
    try {
      if (spec.profile !== undefined && spec.profile !== LOCAL_PROFILE) throw new Error(`profile must be ${LOCAL_PROFILE}`);
      validated = validateRelionSpec(spec, { parts: Object.keys(files), profile: localProfile });
      project = projects.get(validated.project);
      if (!project) throw new Error(`project ${validated.project} does not exist`);
      for (const name of Object.keys(files)) {
        if (!isMrc(files[name])) throw new Error(`${name} is not an MRC file`);
      }
      checkDataInputs(validated);
      dependsOn = resolveDependencies(project, validated);
    } catch (error) {
      return fail(response, 400, 'invalid-spec', error.message);
    }
    const fingerprint = fingerprintOf(validated, files);
    const previous = submissions.get(scopedKey);
    if (previous) return replay(response, previous, fingerprint);
    project.allocated += 1;
    const directory = `${jobTypeDirectory(validated.command)}/job${pad3(project.allocated)}`;
    const jobDir = join(projectDirOf(project.id), directory);
    mkdirSync(jobDir, { recursive: true });
    for (const [name, bytes] of Object.entries(files)) writeFileSync(join(jobDir, `${name}.mrc`), bytes);
    const job = enqueue(response, owner, scopedKey, fingerprint, { spec, validated, files: {}, project: project.id, directory, dependsOn });
    project.jobIds.push(job.id);
    return null;
  };

  const submit = async (request, response, owner) => {
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || !key.trim() || key.length > 200) return fail(response, 400, 'invalid-spec', 'A nonempty Idempotency-Key of at most 200 characters is required');
    const scopedKey = `${owner}:${key}`;
    const type = request.headers['content-type'] || '';
    if (!type.startsWith('multipart/form-data')) return fail(response, 400, 'invalid-spec', 'Expected multipart/form-data');
    const length = Number(request.headers['content-length'] || 0);
    if (length > maxUploadBytes) return fail(response, 413, 'too-large', `Upload exceeds ${maxUploadBytes} bytes`);
    let form;
    try {
      form = await new Response(Readable.toWeb(request), { headers: { 'content-type': type } }).formData();
    } catch (error) {
      return fail(response, 400, 'invalid-spec', `Could not read the upload: ${error.message}`);
    }
    const specPart = form.get('spec');
    if (!specPart) return fail(response, 400, 'invalid-spec', 'Missing spec part');
    let spec;
    try {
      spec = JSON.parse(typeof specPart === 'string' ? specPart : await specPart.text());
    } catch {
      return fail(response, 400, 'invalid-spec', 'spec is not valid JSON');
    }
    const files = {};
    for (const [name, value] of form.entries()) {
      if (name === 'spec' || typeof value === 'string') continue;
      files[name] = Buffer.from(await value.arrayBuffer());
    }
    if (Object.keys(files).length > maxFiles) return fail(response, 413, 'too-large', `More than ${maxFiles} files`);
    if (spec?.tool === 'relion') return submitRelion(response, owner, scopedKey, spec, files);
    let validated;
    try {
      validated = spec?.tool === 'sct' ? validateSctSpec(spec, Object.keys(files)) : validateNesvorSpec(spec, Object.keys(files));
    } catch (error) {
      return fail(response, 400, 'invalid-spec', error.message);
    }
    for (const name of Object.keys(files)) {
      if (!isNifti1(files[name])) return fail(response, 400, 'invalid-spec', `${name} is not a NIfTI-1 file`);
    }
    const fingerprint = fingerprintOf(validated, files);
    const previous = submissions.get(scopedKey);
    if (previous) return replay(response, previous, fingerprint);
    enqueue(response, owner, scopedKey, fingerprint, { spec, validated, files });
    return null;
  };

  const readJson = async request => {
    try {
      return await new Response(Readable.toWeb(request)).json();
    } catch {
      return undefined;
    }
  };

  const publicProject = project => ({
    id: project.id,
    name: project.name,
    createdAt: project.createdAt,
    jobs: project.jobIds.map(id => jobs.get(id)).map(job => ({
      id: job.id,
      command: job.spec.command,
      directory: job.directory,
      status: job.status,
      dependsOn: job.dependsOn,
      createdAt: job.createdAt,
      finishedAt: job.finishedAt,
    })),
  });

  const projectRoute = async (request, response, route) => {
    if (route.length === 1 && request.method === 'POST') {
      const body = await readJson(request);
      const name = body?.name;
      const valid = typeof name === 'string' && [...name].length >= 1 && [...name].length <= 100 && !/\p{Cc}/u.test(name);
      if (!valid) return fail(response, 400, 'invalid-spec', 'name must be 1 to 100 characters without control characters');
      const project = { id: randomBytes(16).toString('hex'), name, createdAt: new Date().toISOString(), allocated: 0, jobIds: [] };
      mkdirSync(projectDirOf(project.id), { recursive: true });
      projects.set(project.id, project);
      return json(response, 201, publicProject(project));
    }
    if (route.length === 1 && request.method === 'GET') {
      const listed = [...projects.values()].reverse().map(project => ({ id: project.id, name: project.name, createdAt: project.createdAt, jobCount: project.jobIds.length }));
      return json(response, 200, { projects: listed });
    }
    const project = route.length === 2 ? projects.get(route[1]) : undefined;
    if (!project) return fail(response, 404, 'not-found', 'Unknown project');
    if (request.method === 'GET') return json(response, 200, publicProject(project));
    if (request.method !== 'DELETE') return fail(response, 404, 'not-found', 'Not found');
    const members = project.jobIds.map(id => jobs.get(id));
    if (members.some(job => ACTIVE.includes(job.status))) return fail(response, 409, 'conflict', 'Cancel the project\'s jobs and wait for them to stop before deletion');
    for (const job of members) jobs.delete(job.id);
    rmSync(projectDirOf(project.id), { recursive: true, force: true });
    projects.delete(project.id);
    response.writeHead(204);
    response.end();
    return null;
  };

  const rootRoute = (request, response, route, url) => {
    if (route.length === 1 && request.method === 'GET') return json(response, 200, { roots: [...roots.keys()].map(id => ({ id, label: id })) });
    const root = route.length === 3 && route[2] === 'entries' && request.method === 'GET' ? roots.get(route[1]) : undefined;
    if (!root) return fail(response, 404, 'not-found', 'Not found');
    try {
      return json(response, 200, listEntries(root, url.searchParams.get('path') ?? '', url.searchParams.get('cursor')));
    } catch {
      return fail(response, 404, 'not-found', 'No such directory in this root');
    }
  };

  // A project output: a listed name, canonically inside the job's directory.
  const serveProjectOutput = (response, job, name) => {
    const output = job.listing.find(item => item.name === name);
    let path = null;
    try {
      const jobDir = jobDirOf(projectDirOf(job.project), job.directory);
      const target = realpathSync(join(projectDirOf(job.project), name));
      if (isInside(jobDir, target)) path = target;
    } catch {
      path = null;
    }
    if (!output || !path || !['succeeded', 'failed', 'cancelled'].includes(job.status)) return fail(response, 404, 'not-found', 'Unknown output');
    if (!output.download) return fail(response, 413, 'too-large', `${name} is larger than the download limit of ${maxDownloadBytes} bytes`);
    const size = statSync(path).size;
    response.writeHead(200, {
      'Content-Type': output.contentType,
      'Content-Length': size,
      'Content-Disposition': `attachment; filename="${name.split('/').at(-1)}"`,
    });
    createReadStream(path).pipe(response);
    return null;
  };

  const events = (request, response, job) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Connection': 'keep-alive' });
    const send = (event, data) => response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    send('status', { status: job.status, position: publicJob(job).position });
    if (job.progress !== null) send('progress', { fraction: job.progress, stage: job.stage });
    for (const entry of job.events) if (entry.event === 'log') send('log', entry.data);
    if (['succeeded', 'failed', 'cancelled'].includes(job.status)) {
      send('done', publicJob(job));
      response.end();
      return;
    }
    const keepalive = setInterval(() => response.write(': keepalive\n\n'), 15000);
    const listener = (event, data) => {
      send(event, data);
      if (event === 'done') {
        clearInterval(keepalive);
        response.end();
      }
    };
    job.listeners.add(listener);
    request.on('close', () => {
      clearInterval(keepalive);
      job.listeners.delete(listener);
    });
  };

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    const originAllowed = cors(request, response);
    if (request.method === 'OPTIONS') {
      response.writeHead(originAllowed ? 204 : 403);
      response.end();
      return;
    }
    if (!originAllowed) return fail(response, 403, 'forbidden', 'Origin is not allowed');
    if (url.pathname === '/__test/fail-next' && request.method === 'POST') {
      failNext = 'RuntimeError: CUDA out of memory';
      response.writeHead(204);
      response.end();
      return;
    }
    if (!url.pathname.startsWith('/api/v1/')) return fail(response, 404, 'not-found', 'Not found');
    const route = url.pathname.slice('/api/v1/'.length).split('/');
    if (route[0] === 'pair' && route.length === 1 && request.method === 'POST') {
      let body;
      try { body = await new Response(Readable.toWeb(request)).json(); }
      catch { return fail(response, 400, 'invalid-spec', 'Expected JSON pairing request'); }
      if (body.code !== token) return fail(response, 401, 'unauthorized', 'Invalid pairing code');
      const clientId = singleOwner ? SINGLE_OWNER : randomBytes(16).toString('hex');
      const credential = randomBytes(32).toString('hex');
      sessions.set(credential, { owner: clientId, lastUsed: clock() });
      return json(response, 200, { token: credential, clientId });
    }
    const owner = ownerOf(request);
    const isAuthorized = Boolean(owner);
    if (route[0] === 'info' && route.length === 1 && request.method === 'GET') {
      const info = { service: 'neurodesk-compute', version: REFERENCE_VERSION, protocol: 1, auth: 'pairing' };
      if (isAuthorized) {
        Object.assign(info, {
          simulated: true,
          runner: 'simulate',
          gpu: { available: false, name: null },
          tools: [{ id: 'nesvor', version: '0.5.0', image: NESVOR_IMAGE, commands: ['reconstruct'] }, { id: 'sct', version: SCT_VERSION, image: SCT_IMAGE, commands: SCT_COMMANDS, gpuRequired: false }],
          limits: { maxUploadBytes, maxFiles, maxDownloadBytes },
          ownership: singleOwner ? 'single' : 'pairing',
          features: singleOwner ? ['projects', 'dataRoots'] : [],
        });
        if (singleOwner) {
          info.tools.push({ id: 'relion', version: RELION_DEFINITION.version, image: RELION_IMAGE, commands: [...RELION_COMMANDS], gpuRequired: false });
          info.dataRoots = [...roots.keys()].map(id => ({ id, label: id }));
          info.profiles = [{ name: LOCAL_PROFILE, summary: `${localProfile.gpus} GPUs, ${localProfile.cpus} CPUs` }];
        }
      }
      return json(response, 200, info);
    }
    if (!isAuthorized) return fail(response, 401, 'unauthorized', 'A valid bearer token is required');
    if (route[0] === 'session' && route.length === 1 && request.method === 'DELETE') {
      sessions.delete(request.headers.authorization.slice(7));
      response.writeHead(204);
      response.end();
      return;
    }
    if (route[0] === 'projects' || route[0] === 'roots') {
      if (!singleOwner) return fail(response, 404, 'not-found', 'Not found');
      if (route[0] === 'roots') return rootRoute(request, response, route, url);
      return projectRoute(request, response, route);
    }
    if (route[0] !== 'jobs') return fail(response, 404, 'not-found', 'Not found');
    if (route.length === 1 && request.method === 'POST') return submit(request, response, owner);
    if (route.length === 1 && request.method === 'GET') return json(response, 200, { jobs: Array.from(jobs.values()).filter(job => job.owner === owner).map(publicJob) });
    const job = jobs.get(route[1]);
    if (!job || job.owner !== owner) return fail(response, 404, 'not-found', 'Unknown job');
    if (route.length === 2 && request.method === 'GET') return json(response, 200, publicJob(job));
    if (route.length === 3 && route[2] === 'cancel' && request.method === 'POST') {
      if (['queued', 'running', 'cancelling'].includes(job.status)) {
        job.cancelled = true;
        const index = queue.indexOf(job);
        if (index >= 0) {
          queue.splice(index, 1);
          finish(job, 'cancelled');
        } else {
          setStatus(job, 'cancelling');
          job.wake?.();
        }
      }
      return json(response, 200, publicJob(job));
    }
    if (route.length === 2 && request.method === 'DELETE') {
      if (['queued', 'running', 'cancelling'].includes(job.status)) return fail(response, 409, 'conflict', 'Cancel the job and wait for its runner to stop before deletion');
      if (job.project) {
        const dependants = [...jobs.values()].filter(other => other.dependsOn.includes(job.id));
        if (dependants.length) return fail(response, 409, 'conflict', `${dependants.map(other => other.directory).join(', ')} depends on this job; delete it first`);
        rmSync(join(projectDirOf(job.project), job.directory), { recursive: true, force: true });
        const project = projects.get(job.project);
        project.jobIds = project.jobIds.filter(id => id !== job.id);
      }
      jobs.delete(job.id);
      response.writeHead(204);
      response.end();
      return null;
    }
    if (route.length === 3 && route[2] === 'events' && request.method === 'GET') return events(request, response, job);
    if (route.length >= 4 && route[2] === 'outputs' && request.method === 'GET') {
      // A name may contain '/', percent-encoded in one segment or as further segments.
      let name;
      try {
        name = route.slice(3).map(decodeURIComponent).join('/');
      } catch {
        return fail(response, 404, 'not-found', 'Unknown output');
      }
      if (job.project) return serveProjectOutput(response, job, name);
      const output = job.status === 'succeeded' ? job.outputs.find(item => item.name === name) : null;
      if (!output) return fail(response, 404, 'not-found', 'Unknown output');
      response.writeHead(200, {
        'Content-Type': output.contentType,
        'Content-Length': output.bytes.length,
        'Content-Disposition': `attachment; filename="${output.name}"`,
      });
      response.end(output.bytes);
      return null;
    }
    return fail(response, 404, 'not-found', 'Not found');
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, host, () => {
      const address = server.address();
      const origin = `http://${host}:${address.port}`;
      resolve({
        origin,
        port: address.port,
        token,
        dataDir: dataPath,
        close: async () => {
          closed = true;
          await new Promise(done => {
            for (const job of jobs.values()) {
              job.cancelled = true;
              job.wake?.();
            }
            server.closeAllConnections?.();
            server.close(() => done());
          });
          await runningJob.catch(() => {});
          if (ownsDataDir) rmSync(dataPath, { recursive: true, force: true });
        },
      });
    });
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argument = (name, fallback) => {
    const index = process.argv.indexOf(name);
    return index < 0 ? fallback : process.argv[index + 1];
  };
  const dataRoots = {};
  process.argv.forEach((value, index) => {
    if (value !== '--data-root') return;
    const [id, ...path] = process.argv[index + 1].split('=');
    dataRoots[id] = path.join('=');
  });
  const server = await startReferenceServer({
    port: Number(argument('--port', 8766)),
    host: argument('--host', '127.0.0.1'),
    token: argument('--token', 'test-token'),
    allowOrigins: (argument('--allow-origin', '') || '').split(',').filter(Boolean),
    stageDelayMs: Number(argument('--stage-delay-ms', 400)),
    singleOwner: process.argv.includes('--single-owner'),
    dataRoots,
    dataDir: argument('--data-dir', null),
    maxDownloadBytes: Number(argument('--max-download-bytes', 2 * 1024 * 1024 * 1024)),
  });
  console.log(`neurodesk-compute reference server (simulated tools) listening at ${server.origin} token=${server.token}`);
}
