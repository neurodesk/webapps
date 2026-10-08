import { serveMcp } from '../../src/mcp.js';
import { validateRequest } from '../../src/contracts.js';

const contracts = [
  {
    schemaVersion: 1,
    app: 'synthseg',
    appVersion: '0.3.20260924',
    title: 'SynthSeg',
    description: 'Segment a brain image.',
    inputs: { image: { type: 'neuro:volume', formats: ['nifti'], space: 'native', description: 'Input image.', selector: '#imageInput' } },
    parameters: {
      mode: { type: 'string', description: 'Segmentation mode.', enum: ['normal', 'fast'], default: 'normal', selector: '#mode', action: 'select' },
      ct: { type: 'boolean', description: 'Override image CT detection.', selector: '#ct', action: 'check' },
    },
    artifacts: { labels: { type: 'neuro:label-map', mediaType: 'application/gzip', space: 'native', selector: '#saveBtn' } },
    controls: { run: '#processButton', cancel: '#cancelBtn', report: '#reportBtn' },
    engines: ['browser'],
  },
  {
    schemaVersion: 1,
    app: 'brain-extraction',
    appVersion: '0.1.20260924',
    title: 'Brain extraction',
    description: 'Extract brain and mask images.',
    inputs: { image: { type: 'neuro:volume', formats: ['nifti'], space: 'native', description: 'Input image.', selector: '#imageInput' } },
    parameters: {
      method: { type: 'string', description: 'Extraction method.', enum: ['bet', 'mindgrab', 'synthstrip'], default: 'bet', selector: '#method', action: 'select' },
      threshold: { type: 'number', description: 'Fractional intensity.', minimum: 0, maximum: 1, default: 0.5, selector: '#threshold', action: 'fill' },
    },
    artifacts: { brain: { type: 'neuro:volume', mediaType: 'application/octet-stream', space: 'native', selector: '#brain' } },
    controls: { run: '#runButton', cancel: '#cancelButton', report: '#reportBtn' },
    engines: ['browser', 'native'],
  },
];
if (process.argv.includes('--parameters')) {
  contracts.push({
    schemaVersion: 2, app: 'settings', title: 'Settings', description: 'Parameter metadata fixture',
    defaultOperation: 'run', operations: { run: {
      title: 'Run', description: 'Inspect settings', mode: 'batch', inputs: {}, artifacts: {}, engines: ['browser'],
      parameters: {
        method: { type: 'string', description: 'Scientific method', enum: ['fast', 'normal'], default: 'normal' },
        threshold: { type: 'number', description: 'Intensity threshold', minimum: 0, maximum: 1, multipleOf: 0.01, default: 0.15 },
        iterations: { type: 'integer', description: 'Iteration count' },
        numeric: { type: 'number', description: 'Numeric choice', enum: [1, 2] },
        flag: { type: 'boolean', description: 'Boolean choice', enum: [false] },
        enabled: { type: 'boolean', description: 'Enable processing', default: false },
        schedule: {
          type: 'array', description: 'Resolution schedule', minimum: 1, maximum: 2, default: [[0.15]],
          items: {
            type: 'array', description: 'Resolution entries', minimum: 1, maximum: 3,
            items: { type: 'number', description: 'Resolution weight', minimum: 0, maximum: 1, multipleOf: 0.01, default: 0.5 },
          },
        },
      },
    } },
  });
}
const runs = new Map();
const resources = new Map();
const active = setInterval(() => {}, 1000);
let closeCount = 0;
const service = {
  async listApps() {
    return contracts;
  },
  async describeApp(app) {
    const contract = contracts.find(contract => contract.app === app);
    if (!contract) throw new Error(`App is not installed: ${app}`);
    return contract;
  },
  async validate(app, request) {
    return validateRequest(await this.describeApp(app), request);
  },
  async start(app, request) {
    const normalized = await this.validate(app, request);
    const id = `run-${runs.size + 1}`;
    const snapshot = { id, app, engine: normalized.engine, state: 'running', startedAt: new Date().toISOString(), reportUri: `neurodesk://runs/${id}/report` };
    runs.set(id, { snapshot, request: normalized });
    return snapshot;
  },
  async get(id) {
    const run = runs.get(id);
    if (!run) throw new Error(`Unknown run: ${id}`);
    if (run.snapshot.state === 'running' && run.request.parameters.mode === 'fast') {
      run.snapshot.state = 'succeeded';
      run.snapshot.finishedAt = new Date().toISOString();
      const uri = `neurodesk://runs/${id}/artifacts/labels`;
      run.snapshot.report = { parameters: run.request.parameters, artifacts: [{ id: 'labels', uri }] };
      resources.set(run.snapshot.reportUri, { uri: run.snapshot.reportUri, mimeType: 'application/json', text: JSON.stringify(run.snapshot.report) });
      resources.set(uri, { uri, mimeType: 'application/gzip', blob: Buffer.from('fixture output').toString('base64') });
    }
    return run.snapshot;
  },
  async cancel(id) {
    const run = runs.get(id);
    if (!run) throw new Error(`Unknown run: ${id}`);
    if (run.snapshot.state === 'running') run.snapshot.state = 'cancelled';
    return run.snapshot;
  },
  async listResources() {
    return [...resources.values()].map(({ uri, mimeType }) => ({ uri, mimeType, name: uri.split('/').at(-1) }));
  },
  async readResource(uri) {
    const resource = resources.get(uri);
    if (!resource) throw new Error(`Unknown resource: ${uri}`);
    return [resource];
  },
  async close() {
    ++closeCount;
    for (const run of runs.values()) await this.cancel(run.snapshot.id);
    clearInterval(active);
    console.error(JSON.stringify({ closeCount, states: [...runs.values()].map(run => run.snapshot.state) }));
  },
};

const handle = serveMcp(service, { version: '0.14.20260928' });
if (process.argv.includes('--close-twice')) {
  await handle.close();
  await handle.close();
}
