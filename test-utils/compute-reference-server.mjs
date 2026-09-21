// Node reference implementation of the remote compute protocol v1 with the
// simulated nesvor tool. Used by browser tests, the desktop workflow and the
// protocol conformance test. See docs/architecture/remote-compute-protocol.md.
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { isNifti1, readVolume, writeFloat32Volume } from './nifti-fixture.mjs';
import { validateNesvorSpec, nesvorArgv } from '../apps/nesvor/src/spec.js';

export const REFERENCE_VERSION = '0.1.20260921';
export const NESVOR_IMAGE = 'vnmd/nesvor_0.5.0@sha256:4a9b346297bd5c10af4047745b6fa82f2912e06c8fecaab615f2adcb32599f64';
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

export function startReferenceServer({ port = 0, host = '127.0.0.1', token = 'test-token', allowOrigins = [], stageDelayMs = 40, maxUploadBytes = 512 * 1024 * 1024, maxFiles = 40 } = {}) {
  const jobs = new Map();
  let failNext = null;
  let running = null;
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
      response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
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

  const authorized = (request, url) => {
    const header = request.headers.authorization || '';
    const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
    return bearer === token || url.searchParams.get('token') === token;
  };

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
    outputs: job.status === 'succeeded' ? job.outputs.map(({ name, bytes, contentType }) => ({ name, bytes: bytes.length, contentType })) : [],
  });

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
    setStatus(job, status);
    emit(job, 'done', publicJob(job));
    job.listeners.clear();
  };

  const run = async job => {
    job.startedAt = new Date().toISOString();
    setStatus(job, 'running');
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
    if (running || !queue.length) return;
    running = queue.shift();
    for (const job of queue) emit(job, 'status', { status: 'queued', position: publicJob(job).position });
    void run(running).finally(() => {
      running = null;
      pump();
    });
  };

  const submit = async (request, response) => {
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
    let validated;
    try {
      validated = validateNesvorSpec(spec, Object.keys(files));
    } catch (error) {
      return fail(response, 400, 'invalid-spec', error.message);
    }
    for (const name of Object.keys(files)) {
      if (!isNifti1(files[name])) return fail(response, 400, 'invalid-spec', `${name} is not a NIfTI-1 file`);
    }
    const job = {
      id: randomBytes(16).toString('hex'),
      spec,
      validated,
      files,
      status: 'queued',
      progress: null,
      stage: null,
      message: null,
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      error: null,
      outputs: [],
      log: [],
      events: [],
      listeners: new Set(),
      cancelled: false,
      wake: null,
    };
    jobs.set(job.id, job);
    queue.push(job);
    const payload = { id: job.id, status: 'queued', position: publicJob(job).position };
    json(response, 202, payload);
    pump();
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
    if (url.pathname === '/__test/fail-next' && request.method === 'POST') {
      failNext = 'RuntimeError: CUDA out of memory';
      response.writeHead(204);
      response.end();
      return;
    }
    if (!url.pathname.startsWith('/api/v1/')) return fail(response, 404, 'not-found', 'Not found');
    const route = url.pathname.slice('/api/v1/'.length).split('/');
    const isAuthorized = authorized(request, url);
    if (route[0] === 'info' && route.length === 1 && request.method === 'GET') {
      const info = { service: 'neurodesk-compute', version: REFERENCE_VERSION, protocol: 1, auth: 'bearer' };
      if (isAuthorized) {
        Object.assign(info, {
          simulated: true,
          runner: 'simulate',
          gpu: { available: false, name: null },
          tools: [{ id: 'nesvor', version: '0.5.0', image: NESVOR_IMAGE, commands: ['reconstruct'] }],
          limits: { maxUploadBytes, maxFiles },
        });
      }
      return json(response, 200, info);
    }
    if (!isAuthorized) return fail(response, 401, 'unauthorized', 'A valid bearer token is required');
    if (route[0] !== 'jobs') return fail(response, 404, 'not-found', 'Not found');
    if (route.length === 1 && request.method === 'POST') return submit(request, response);
    const job = jobs.get(route[1]);
    if (!job) return fail(response, 404, 'not-found', 'Unknown job');
    if (route.length === 2 && request.method === 'GET') return json(response, 200, publicJob(job));
    if (route.length === 2 && request.method === 'DELETE') {
      job.cancelled = true;
      const index = queue.indexOf(job);
      if (index >= 0) {
        queue.splice(index, 1);
        finish(job, 'cancelled');
      } else if (job.status === 'running') {
        job.wake?.();
      }
      jobs.delete(job.id);
      response.writeHead(204);
      response.end();
      return null;
    }
    if (route.length === 3 && route[2] === 'events' && request.method === 'GET') return events(request, response, job);
    if (route.length === 4 && route[2] === 'outputs' && request.method === 'GET') {
      const output = job.status === 'succeeded' ? job.outputs.find(item => item.name === decodeURIComponent(route[3])) : null;
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
        close: () => new Promise(done => {
          for (const job of jobs.values()) {
            job.cancelled = true;
            job.wake?.();
          }
          server.closeAllConnections?.();
          server.close(() => done());
        }),
      });
    });
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argument = (name, fallback) => {
    const index = process.argv.indexOf(name);
    return index < 0 ? fallback : process.argv[index + 1];
  };
  const server = await startReferenceServer({
    port: Number(argument('--port', 8766)),
    host: argument('--host', '127.0.0.1'),
    token: argument('--token', 'test-token'),
    allowOrigins: (argument('--allow-origin', '') || '').split(',').filter(Boolean),
    stageDelayMs: Number(argument('--stage-delay-ms', 400)),
  });
  console.log(`neurodesk-compute reference server (simulated nesvor) listening at ${server.origin} token=${server.token}`);
}
