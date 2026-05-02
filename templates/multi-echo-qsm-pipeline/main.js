import { createNeuroWebapp } from '../../src/core/index.js';
import { FileIOController } from '../../src/file-io/index.js';
import { PipelineRegistry } from '../../src/pipeline/index.js';
import { qsmPlugin, generateQsmxtCommand } from '../../src/plugins/qsm/index.js';

const registry = new PipelineRegistry();
registry.registerPlugin(qsmPlugin);

const app = createNeuroWebapp({
  title: 'QSM Pipeline',
  subtitle: 'Template',
  plugins: [qsmPlugin],
  sidebarSections: [{ id: 'input', title: 'Input buckets', content: 'Drop magnitude, phase, field map, JSON, or mask files.' }]
});

const files = new FileIOController({
  mode: 'bucketed',
  updateOutput: message => app.console.log(message)
});

const command = generateQsmxtCommand({ dipoleInversion: 'tv', tv: { lambda: 0.01 } });
app.console.log(command);

globalThis.templateApp = { app, files, registry };
