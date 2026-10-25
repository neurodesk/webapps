import assert from 'node:assert/strict';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileHash } from '../../packages/desktop/src/bundle.js';
import { makeRequest } from '../../packages/desktop/neuroflow/runtime/contract.mjs';
import { openDesktop } from '../../packages/desktop/neuroflow/runtime/stdio.mjs';

const execute = promisify(execFile);

/** Preserve member hashes and container timestamps without weakening archive equality. */
export async function zipEvidence(path) {
  const { stdout: listing } = await execute('unzip', ['-Z1', path]);
  const { stdout: metadata } = await execute('unzip', ['-Z', '-T', path]);
  const members = {};
  for (const name of listing.trim().split('\n').filter(Boolean).sort()) {
    const { stdout } = await execute('unzip', ['-p', path, name], { encoding: 'buffer', maxBuffer: 512 * 1024 * 1024 });
    members[name] = {
      bytes: stdout.length,
      sha256: createHash('sha256').update(stdout).digest('hex'),
      ...(name === 'header.json' ? { header: JSON.parse(stdout.toString('utf8')) } : {}),
    };
  }
  return { sha256: await fileHash(path), bytes: (await stat(path)).size, metadata, members };
}

const timingKeys = new Set(['elapsedMs', 'elapsedSeconds', 'durationMs', 'processingMs', 'seconds', 'Seconds', 'fitSeconds']);

export function scientificProvenance(value) {
  if (Array.isArray(value)) return value.map(scientificProvenance);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !timingKeys.has(key))
    .map(([key, item]) => [key, scientificProvenance(item)]));
}

export function resolveStepInputs(step, workflowInputs, results) {
  return Object.fromEntries(Object.entries(step.inputs).map(([name, binding]) => {
    if (Object.hasOwn(binding, 'constant')) return [name, binding.constant];
    const [kind, id, , output] = binding.ref.split('.');
    const value = kind === 'inputs' ? workflowInputs[id] : results[id]?.[output];
    assert.notEqual(value, undefined, `Missing fixed input ${binding.ref}`);
    return [name, value];
  }));
}

/** Re-run each app directly, outside NeuroFlow, with the chain's exact inputs. */
export async function compareIndividualApps({ workflow, inputs, results, tools, scratch, env, connect = openDesktop }) {
  const comparisons = [];
  for (const [id, step] of Object.entries(workflow.steps)) {
    console.log(`Comparing ${id} with its independent desktop operation`);
    const tool = tools.find(tool => tool.id === step.tool);
    const request = makeRequest(tool, resolveStepInputs(step, inputs, results), Number(env.NEURODESK_TIMEOUT_MS));
    const output = join(scratch, 'individual', id);
    const client = connect(env.NEURODESK_WEBAPPS,
      [...JSON.parse(env.NEURODESK_WEBAPPS_ARGS), '--mcp', '--output', output], { env });
    const snapshots = [];
    const record = snapshot => {
      const entry = Object.fromEntries(['id', 'state', 'phase', 'message', 'progress', 'error'].filter(key => snapshot[key] !== undefined)
        .map(key => [key, snapshot[key]]));
      if (JSON.stringify(snapshots.at(-1)?.snapshot) !== JSON.stringify(entry)) snapshots.push({ at: new Date().toISOString(), snapshot: entry });
    };
    try {
      await client.initialize();
      await client.tool('apps_validate', request);
      let snapshot = await client.tool('runs_start', request);
      record(snapshot);
      const runId = snapshot.id;
      const deadline = Date.now() + request.timeoutMs;
      while (snapshot.state === 'running') {
        assert.ok(Date.now() < deadline, `Independent ${id} exceeded its deadline`);
        await delay(1000);
        snapshot = await client.tool('runs_get', { runId });
        record(snapshot);
      }
      assert.equal(snapshot.state, 'succeeded', JSON.stringify(snapshot.error));
      const resources = await client.resource(`neurodesk://runs/${runId}/report`);
      const content = resources.contents[0];
      const standalone = JSON.parse(content.text ?? Buffer.from(content.blob, 'base64').toString('utf8'));
      const chained = JSON.parse(await readFile(results[id].report));
      for (const key of ['app', 'appVersion', 'operation', 'engine', 'parameters', 'provenance', 'measurements']) {
        assert.deepEqual(scientificProvenance(standalone[key]), scientificProvenance(chained[key]), `${id}.${key} matches the independent app`);
      }
      const scientific = report => Object.fromEntries(Object.entries(report.artifacts).filter(([, artifact]) => !['report', 'log'].includes(artifact.role)));
      const artifacts = scientific(standalone);
      assert.deepEqual(Object.keys(artifacts).sort(), Object.keys(scientific(chained)).sort(), `${id} produced the same artifact set`);
      for (const [key, artifact] of Object.entries(artifacts)) {
        const independentPath = join(output, runId, 'outputs', artifact.filename);
        assert.equal(await fileHash(independentPath), artifact.sha256, `${id}.${key} independent bytes match its report`);
        if (artifact.mediaType === 'application/json') {
          const chainedPaths = [results[id][tool.extensions['neurodesk/automation'].artifacts[artifact.role]]].flat();
          const chainedPath = chainedPaths.find(path => path.endsWith(`/${artifact.filename}`));
          assert.ok(chainedPath, `${id}.${key} has its chained JSON artifact`);
          assert.deepEqual(scientificProvenance(JSON.parse(await readFile(independentPath))),
            scientificProvenance(JSON.parse(await readFile(chainedPath))), `${id}.${key} JSON differs only in execution timing`);
        } else {
          if (artifact.sha256 !== chained.artifacts[key].sha256 && artifact.mediaType === 'application/zip') {
            const chainedPaths = [results[id][tool.extensions['neurodesk/automation'].artifacts[artifact.role]]].flat();
            const chainedPath = chainedPaths.find(path => path.endsWith(`/${artifact.filename}`));
            let evidence;
            try {
              evidence = { independent: await zipEvidence(independentPath), chained: await zipEvidence(chainedPath) };
            } catch (error) {
              evidence = { diagnosticError: error.message };
            }
            const logs = join(scratch, 'logs');
            await mkdir(logs, { recursive: true });
            await writeFile(join(logs, `${id}.${key}.archive-comparison.json`), `${JSON.stringify(evidence, null, 2)}\n`);
          }
          assert.equal(artifact.sha256, chained.artifacts[key].sha256, `${id}.${key} equals the independently executed app output`);
          assert.equal(artifact.bytes, chained.artifacts[key].bytes, `${id}.${key} byte count`);
        }
      }
      comparisons.push({ step: id, passed: true, runId, artifacts, provenance: scientificProvenance(standalone.provenance) });
    } finally {
      try { await client.close(); }
      finally {
        const logs = join(scratch, 'logs');
        await mkdir(logs, { recursive: true });
        await writeFile(join(logs, `${id}.desktop-diagnostics.json`), `${JSON.stringify({ snapshots, ...client.diagnostics?.() }, null, 2)}\n`);
      }
    }
  }
  return comparisons;
}
