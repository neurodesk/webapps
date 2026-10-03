import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { operationFor, parseContract, validateRequest } from './contracts.js';
import { describeFile } from './reports.js';
import { createViewerSessions } from './viewer-sessions.js';

export async function loadAutomationContracts(root, bundle) {
  const contracts = [];
  for (const app of bundle.apps) {
    const path = `site/${app.path}/automation.json`;
    const expected = bundle.files?.[path];
    if (!expected) continue;
    const bytes = await readFile(join(root, path));
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (bytes.length !== expected.bytes || sha256 !== expected.sha256) throw new Error(`Automation contract is corrupt: ${app.id}`);
    const contract = parseContract(JSON.parse(bytes));
    if (contract.app !== app.id || !contract.appVersion) throw new Error(`Invalid published contract: ${app.id}`);
    contracts.push({ contract, sha256 });
  }
  return contracts;
}

export function createAutomationService({ contracts, outputRoot, execute, nativeBinary, sessionOptions }) {
  const catalog = new Map(contracts.map(entry => [entry.contract.app, entry]));
  const runs = new Map();
  const viewers = createViewerSessions(sessionOptions);
  let closed = false;
  let active;
  const lookup = app => {
    const entry = catalog.get(app);
    if (!entry) throw new Error(`No automation contract for app: ${app}`);
    return entry;
  };
  const runFor = id => {
    const run = runs.get(id);
    if (!run) throw new Error(`Unknown run: ${id}`);
    return run;
  };
  const snapshot = run => structuredClone(run.snapshot);
  const resourcesFor = run => {
    if (run.snapshot.state !== 'succeeded') return [];
    return [
      { uri: run.snapshot.reportUri, name: `${run.snapshot.app} run ${run.snapshot.id}`, mimeType: 'application/json' },
      ...Object.entries(run.snapshot.report.artifacts).map(([role, artifact]) => ({
        uri: `neurodesk://runs/${run.snapshot.id}/artifacts/${role}`,
        name: artifact.filename,
        mimeType: artifact.mediaType,
      })),
    ];
  };
  const validate = async (app, value) => {
    const request = await validateRequest(lookup(app).contract, value);
    if (request.engine === 'native') {
      if (!nativeBinary || app !== 'synthseg') throw new Error('Native SynthSeg is unavailable. Set NEURODESK_SYNTHSEG_BIN to its installed executable.');
      if (request.parameters.ct === undefined) throw new Error('Native SynthSeg requires an explicit ct parameter.');
      if (request.inputs.image.length !== 1 || !/\.nii(?:\.gz)?$/i.test(request.inputs.image[0])) {
        throw new Error('Native SynthSeg requires one NIfTI input; convert DICOM with the browser engine first.');
      }
      if (request.retainViewer) throw new Error('The native engine does not provide a viewer');
    }
    return request;
  };
  const persist = run => writeFile(join(run.directory, 'run.json'), `${JSON.stringify(run.snapshot, null, 2)}\n`);
  return {
    async listApps() {
      return [...catalog.values()].map(({ contract, sha256 }) => ({
        ...structuredClone(contract),
        contractSha256: sha256,
        availableEngines: [...new Set((contract.schemaVersion === 2
          ? Object.values(contract.operations).flatMap(operation => operation.engines)
          : contract.engines).filter(engine => engine === 'browser' || (contract.app === 'synthseg' && Boolean(nativeBinary))))],
      }));
    },
    async describeApp(app) {
      const { contract, sha256 } = lookup(app);
      return { ...structuredClone(contract), contractSha256: sha256 };
    },
    validate,
    async start(app, value) {
      const request = await validate(app, value);
      if (active && active.snapshot.state !== 'running') await active.done.catch(() => {});
      if (closed) throw new Error('Automation service is closed');
      if (active) throw new Error(`Another scientific run is active: ${active.snapshot.id}`);
      if (request.retainViewer) viewers.assertCapacity();
      const id = randomUUID();
      const directory = resolve(outputRoot, id);
      const outputDirectory = join(directory, 'outputs');
      const controller = new AbortController();
      const run = {
        directory,
        outputDirectory,
        controller,
        snapshot: { id, app, engine: request.engine, request, state: 'running', phase: 'preparing', startedAt: new Date().toISOString() },
      };
      runs.set(id, run);
      active = run;
      const { contract, sha256 } = lookup(app);
      run.snapshot.contractSha256 = sha256;
      run.done = (async () => {
        const timer = setTimeout(() => controller.abort(new Error(`Run timed out after ${request.timeoutMs} ms`)), request.timeoutMs);
        let retained;
        let sessionInfo;
        let accepted;
        try {
          await mkdir(outputDirectory, { recursive: true });
          await persist(run);
          controller.signal.throwIfAborted();
          run.snapshot.phase = 'processing';
          const outcome = await execute({
            contract, operation: operationFor(contract, request.operation), request, outputDirectory, signal: controller.signal, nativeBinary,
            onProgress(page) {
              if (controller.signal.aborted) return;
              run.snapshot.phase = page.state === 'succeeded' ? 'exporting' : 'processing';
              run.snapshot.message = page.message;
            },
            acceptBrowserOutcome(candidate) {
              controller.signal.throwIfAborted();
              if (accepted) throw new Error('Browser outcome was already accepted');
              retained = candidate.session;
              if (retained && !request.retainViewer) throw new Error('Execution returned an unrequested viewer session');
              if (!retained && request.retainViewer) throw new Error('Execution did not provide the requested viewer session');
              if (retained) sessionInfo = viewers.add({ app, runId: id, adapter: retained,
                isReady: () => run.snapshot.state === 'succeeded',
              });
              accepted = candidate;
            },
          });
          if (request.engine === 'native') controller.signal.throwIfAborted();
          const report = retained ? outcome.report : outcome;
          run.snapshot = {
            ...run.snapshot,
            state: 'succeeded',
            phase: 'complete',
            finishedAt: new Date().toISOString(),
            reportUri: `neurodesk://runs/${id}/report`,
            report: { ...report, executionId: id, engine: request.engine, contractSha256: sha256, outputDirectory },
            ...(sessionInfo && { session: sessionInfo }),
          };
        } catch (error) {
          if (sessionInfo) await viewers.close(sessionInfo.id);
          else if (retained) await retained.close();
          const cancelled = controller.signal.aborted && controller.signal.reason?.name === 'AbortError';
          run.snapshot = {
            ...run.snapshot,
            state: cancelled ? 'cancelled' : 'failed',
            phase: 'complete',
            finishedAt: new Date().toISOString(),
            error: { code: cancelled ? 'CANCELLED' : controller.signal.aborted ? 'TIMEOUT' : error.code ?? 'EXECUTION_FAILED',
              message: String(error.message ?? error), ...(error.candidates && { candidates: error.candidates }) },
          };
          await rm(outputDirectory, { recursive: true, force: true });
        } finally {
          clearTimeout(timer);
          await persist(run).catch(error => console.error(`Could not save run record: ${error.message}`));
          if (active === run) active = undefined;
        }
      })();
      // Store failures in the run record; no detached rejection may end the server.
      run.done.catch(error => console.error(`Run cleanup failed: ${error.message}`));
      return snapshot(run);
    },
    async get(id) {
      return snapshot(runFor(id));
    },
    async listSessions() { return viewers.list(); },
    async viewerCommand(sessionId, command, args) { return viewers.command(sessionId, command, args); },
    async closeSession(sessionId) { return viewers.close(sessionId); },
    async cancel(id) {
      const run = runFor(id);
      if (run.snapshot.state === 'running') {
        run.controller.abort(new DOMException('Run cancelled', 'AbortError'));
        await run.done;
      }
      return snapshot(run);
    },
    async listResources() {
      return [...runs.values()].flatMap(resourcesFor);
    },
    async readResource(uri) {
      for (const run of runs.values()) {
        const resource = resourcesFor(run).find(candidate => candidate.uri === uri);
        if (!resource) continue;
        if (uri === run.snapshot.reportUri) return [{ uri, mimeType: 'application/json', text: JSON.stringify(run.snapshot.report, null, 2) }];
        const role = uri.slice(uri.lastIndexOf('/') + 1);
        const artifact = run.snapshot.report.artifacts[role];
        if (artifact.filename !== basename(artifact.filename)) throw new Error('Invalid artifact filename');
        const path = await realpath(join(run.outputDirectory, artifact.filename));
        if (dirname(path) !== await realpath(run.outputDirectory)) throw new Error('Artifact escaped its run directory');
        const actual = await describeFile(path);
        if (actual.sha256 !== artifact.sha256 || actual.bytes !== artifact.bytes) throw new Error('Artifact changed after completion');
        if (actual.bytes > 64 * 1024 * 1024) throw new Error(`Artifact exceeds the 64 MiB MCP read limit. Read the verified local file: ${path}`);
        const bytes = await readFile(path);
        return artifact.mediaType === 'application/json'
          ? [{ uri, mimeType: artifact.mediaType, text: bytes.toString('utf8') }]
          : [{ uri, mimeType: artifact.mediaType, blob: bytes.toString('base64') }];
      }
      throw new Error(`Unknown or unavailable resource: ${uri}`);
    },
    async close() {
      closed = true;
      if (active) {
        active.controller.abort(new DOMException('MCP connection closed', 'AbortError'));
        await active.done;
      }
      await viewers.closeAll();
    },
  };
}
