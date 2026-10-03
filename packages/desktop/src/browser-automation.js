import { isDeepStrictEqual } from 'node:util';
import { describeFile, verifyOperationReport } from './reports.js';

export function browserDispatcher(contents, { signal, timeoutMs = 30000 } = {}) {
  const commands = new Set(['describe', 'adopt', 'start', 'snapshot', 'cancel', 'download',
    'viewers.list', 'viewers.state', 'viewers.crosshair', 'viewers.tab', 'viewers.regions']);
  const deadline = Date.now() + timeoutMs;
  async function bounded(promise) {
    signal?.throwIfAborted();
    if (Date.now() >= deadline) throw new Error('Browser operation timed out');
    let timer;
    let abort;
    try {
      return await new Promise((resolve, reject) => {
        abort = () => reject(signal.reason);
        timer = setTimeout(() => reject(new Error('Browser operation timed out')), Math.max(1, deadline - Date.now()));
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
        Promise.resolve(promise).then(resolve, reject);
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }
  return {
    bounded,
    async ready() {
      while (!await bounded(contents.executeJavaScript('Boolean(globalThis.neurodeskAutomation?.dispatch)'))) {
        await bounded(new Promise(resolve => setTimeout(resolve, 100)));
      }
      return this.call('describe');
    },
    async call(command, args = {}) {
      if (!commands.has(command)) throw new Error(`Unsupported browser command: ${command}`);
      const result = await bounded(contents.executeJavaScript(`(async () => {
        try { return { ok: true, value: await globalThis.neurodeskAutomation.dispatch(${JSON.stringify(command)}, ${JSON.stringify(args)}) }; }
        catch (error) { return { ok: false, message: String(error?.message ?? JSON.stringify(error) ?? error) }; }
      })()`));
      if (!result.ok) throw new Error(result.message);
      return result.value;
    },
  };
}

export async function runBrowserOperation(contents, { contract, operation, request, artifacts, signal, onProgress = () => {}, mountDirectory }) {
  const page = browserDispatcher(contents, { signal, timeoutMs: request.timeoutMs });
  const manifest = await page.ready();
  const registered = manifest.contract ?? manifest;
  if (!isDeepStrictEqual(registered, contract)) throw new Error('Registered app contract differs from its published contract');
  const inputs = {};
  const browserInputs = {};
  let snapshot;
  let runId;
  async function observe() {
    signal?.throwIfAborted();
    artifacts.assertHealthy();
    snapshot = await page.call('snapshot');
    if (snapshot.runId !== runId) throw new Error('App operation changed during execution');
    if (snapshot.state === 'failed' || snapshot.state === 'cancelled') {
      const error = new Error(`${contract.app} reported an error: ${snapshot.error?.message ?? snapshot.message}`);
      error.code = snapshot.error?.code;
      error.candidates = snapshot.error?.candidates;
      throw error;
    }
    onProgress(snapshot);
    return snapshot;
  }
  const pause = () => page.bounded(new Promise(resolve => setTimeout(resolve, 100)));
  try {
    contents.debugger.attach('1.3');
    for (const [role, field] of Object.entries(operation.inputs)) {
      const source = request.inputs[role];
      if (!source) {
        inputs[role] = [];
        continue;
      }
      if (field.source === 'files') {
        inputs[role] = [];
        for (const path of source) inputs[role].push(await page.bounded(describeFile(path)));
        const { root } = await page.bounded(contents.debugger.sendCommand('DOM.getDocument'));
        const { nodeId } = await page.bounded(contents.debugger.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector: '#neurodesk-input-transfer' }));
        if (!nodeId) throw new Error('App file transfer input is unavailable');
        await page.bounded(contents.debugger.sendCommand('DOM.setFileInputFiles', { nodeId, files: source }));
        await page.call('adopt', { role });
      } else {
        const url = field.source === 'directory' ? await page.bounded(mountDirectory(source.directory)) : source.url;
        browserInputs[role] = { url };
        inputs[role] = { url };
      }
    }
    const started = await page.call('start', {
      operation: request.operation, inputs: browserInputs, parameters: request.parameters, selections: request.selections,
    });
    runId = started.runId ?? started.id;
    if (!runId) throw new Error('App did not return an operation ID');
    while ((await observe()).state !== 'succeeded') await pause();
    const ids = [...Object.keys(snapshot.report?.artifacts ?? {}), 'report'];
    for (const artifactId of ids) {
      await artifacts.download(artifactId, () => page.call('download', { artifactId }), observe);
    }
    await observe();
    return await artifacts.verify(({ output, downloads }) =>
      page.bounded(verifyOperationReport({ operation, snapshot, downloads, output, inputs, parameters: request.parameters })));
  } finally {
    if (!contents.isDestroyed() && contents.debugger.isAttached()) contents.debugger.detach();
  }
}
