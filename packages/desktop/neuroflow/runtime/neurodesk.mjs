#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, realpathSync } from 'node:fs';
import { appendFile, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { pipeline } from 'node:stream/promises';
import { contractHash, makeRequest } from './contract.mjs';
import { openDesktop } from './stdio.mjs';

const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export async function runSession({ env = process.env, signal, connect = openDesktop } = {}) {
  const session = env.NEUROFLOW_SESSION;
  if (!session || !isAbsolute(session)) throw new Error('NEUROFLOW_SESSION must be an absolute directory');
  const context = await readJson(join(session, 'context.json'));
  const match = /^neurodesk\.webapps\/([a-z][a-z0-9-]*)\/([a-z][a-z0-9-]*)$/.exec(context.tool);
  if (!match) throw new Error('Unknown Neurodesk tool ID in session context');
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const tool = await readJson(join(root, 'tools', match[1], `${match[2]}.tool.json`));
  const binding = tool.extensions?.['neurodesk/automation'];
  if (tool.id !== context.tool || binding?.schemaVersion !== 1 || contractHash(binding.contract) !== binding.contractSha256) {
    throw new Error('Generated tool identity or contract hash mismatch');
  }
  const output = env.NEUROFLOW_OUTPUT_DIR ?? context.outputDir;
  const work = env.NEUROFLOW_WORK_DIR ?? context.workDir;
  if (![output, work].every(path => typeof path === 'string' && isAbsolute(path))) throw new Error('Session output and work directories must be absolute');
  const timeoutMs = Number(env.NEURODESK_TIMEOUT_MS ?? 1800000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 86400000) throw new Error('NEURODESK_TIMEOUT_MS must be an integer from 1 to 86400000');
  const args = JSON.parse(env.NEURODESK_WEBAPPS_ARGS ?? '[]');
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) throw new Error('NEURODESK_WEBAPPS_ARGS must be a JSON array of strings');
  if (!context.inputs || Array.isArray(context.inputs) || typeof context.inputs !== 'object') throw new Error('Session inputs must be an object');
  const request = makeRequest(tool, context.inputs, timeoutMs);
  await mkdir(output, { recursive: true });
  await mkdir(work, { recursive: true });
  // A failed retry must never leave an earlier result available for harvesting.
  const resultPath = join(output, 'result.json');
  await rm(resultPath, { force: true });
  const scratch = await mkdtemp(join(work, 'neurodesk-'));
  const artifactsDir = await mkdtemp(join(output, 'artifacts-'));
  const deadline = AbortSignal.timeout(timeoutMs);
  const activeSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const client = connect(env.NEURODESK_WEBAPPS || 'neurodesk-webapps', [...args, '--mcp', '--output', join(scratch, 'runs')], { env });
  let runId;
  let published = false;
  try {
    const options = { signal: activeSignal };
    await client.initialize(options);
    const actual = await client.tool('apps_describe', { app: request.app }, options);
    const { contractSha256: ignored, ...installed } = actual;
    if (contractHash(installed) !== binding.contractSha256) throw new Error('Installed application contract differs; regenerate the NeuroFlow bundle');
    await client.tool('apps_validate', request, options);
    const started = await client.tool('runs_start', request, options);
    runId = started.id;
    if (typeof runId !== 'string' || !/^[a-zA-Z0-9-]+$/.test(runId)) throw new Error('Desktop returned an invalid run ID');
    let snapshot = started;
    while (snapshot.state === 'running') {
      await delay(100, undefined, options);
      snapshot = await client.tool('runs_get', { runId }, options);
    }
    if (snapshot.state !== 'succeeded') throw new Error(snapshot.error?.message ?? `Desktop run ${snapshot.state}`);
    const reportUri = `neurodesk://runs/${runId}/report`;
    const reportResource = await client.resource(reportUri, options);
    const report = JSON.parse(resourceBytes(reportResource, reportUri).toString('utf8'));
    if (report.app !== request.app || report.operation !== request.operation || report.appVersion !== tool.version
      || report.executionId !== runId || report.status !== 'succeeded' || report.engine !== request.engine) {
      throw new Error('Desktop report identity mismatch');
    }
    const operation = binding.contract.operations[binding.operation];
    const result = Object.fromEntries(Object.values(binding.artifacts).map(name => [name, []]));
    for (const [id, artifact] of Object.entries(report.artifacts)) {
      activeSignal.throwIfAborted();
      const isReport = id === 'report' && artifact.role === 'report' && artifact.type === 'neuro:report'
        && artifact.mediaType === 'application/json';
      const field = isReport ? { type: 'neuro:report' } : operation.artifacts[artifact.role];
      if (!field || !/^[a-zA-Z0-9_-]+$/.test(id) || !artifact.filename || basename(artifact.filename) !== artifact.filename || /[\\/]/.test(artifact.filename)) {
        throw new Error('Invalid desktop artifact identity');
      }
      if (![field.type].flat().includes(artifact.type)) throw new Error(`Artifact type mismatch: ${id}`);
      const directory = join(artifactsDir, id);
      await mkdir(directory);
      const path = join(directory, artifact.filename);
      if (artifact.bytes > 64 * 1024 * 1024) {
        const sourceRoot = await realpath(join(scratch, 'runs', runId, 'outputs'));
        const source = await realpath(join(sourceRoot, artifact.filename));
        if (dirname(source) !== sourceRoot) throw new Error('Artifact escaped its run directory');
        const hash = createHash('sha256');
        let bytes = 0;
        await pipeline(createReadStream(source), async function* (chunks) {
          for await (const chunk of chunks) {
            bytes += chunk.length;
            hash.update(chunk);
            yield chunk;
          }
        }, createWriteStream(path, { flags: 'wx' }), { signal: activeSignal });
        if (bytes !== artifact.bytes || hash.digest('hex') !== artifact.sha256) throw new Error(`Artifact checksum mismatch: ${id}`);
      } else {
        const uri = `neurodesk://runs/${runId}/artifacts/${id}`;
        const bytes = resourceBytes(await client.resource(uri, options), uri);
        if (bytes.length !== artifact.bytes || sha256(bytes) !== artifact.sha256) throw new Error(`Artifact checksum mismatch: ${id}`);
        await writeFile(path, bytes);
      }
      if (!isReport) result[binding.artifacts[artifact.role]].push(path);
    }
    for (const [role, field] of Object.entries(operation.artifacts)) {
      const name = binding.artifacts[role];
      const count = result[name].length;
      if (count < field.minimum || count > (field.maximum ?? Infinity)) throw new Error(`Artifact cardinality mismatch: ${role}`);
      // A single-file role is a scalar NeuroFlow output; an absent optional one is omitted.
      if (field.maximum === 1) {
        if (count) result[name] = result[name][0];
        else delete result[name];
      }
    }
    result.report = join(artifactsDir, 'report.json');
    await writeFile(result.report, `${JSON.stringify(report, null, 2)}\n`);
    await appendFile(join(session, 'provenance.jsonl'), `${JSON.stringify({
      ts: new Date().toISOString(), step: context.step, tool: tool.id, action: 'neurodesk-automation',
      agent: `neurodesk-webapps@${tool.version}`, contractSha256: binding.contractSha256,
      engine: report.engine, runId, outputs: result,
    })}\n`);
    activeSignal.throwIfAborted();
    const temporary = join(artifactsDir, 'result.json');
    await writeFile(temporary, `${JSON.stringify(result, null, 2)}\n`);
    await rename(temporary, resultPath);
    published = true;
    return result;
  } catch (error) {
    if (activeSignal.aborted) throw activeSignal.reason;
    throw error;
  } finally {
    if (runId && !published) await client.tool('runs_cancel', { runId }, { timeoutMs: 2000 }).catch(() => {});
    await client.close();
    await rm(scratch, { recursive: true, force: true });
    if (!published) await rm(artifactsDir, { recursive: true, force: true });
  }
}

function resourceBytes(resource, uri) {
  if (resource.contents?.length !== 1 || resource.contents[0].uri !== uri) throw new Error('Desktop resource identity mismatch');
  const item = resource.contents[0];
  if (typeof item.blob === 'string') return Buffer.from(item.blob, 'base64');
  if (typeof item.text === 'string') return Buffer.from(item.text, 'utf8');
  throw new Error('Desktop resource has no content');
}

// Node resolves the module URL through symlinks (macOS puts TMPDIR under /var); compare real paths.
if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  const controller = new AbortController();
  const cancel = () => controller.abort(new DOMException('NeuroFlow cancelled the tool', 'AbortError'));
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try { await runSession({ signal: controller.signal }); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
}
