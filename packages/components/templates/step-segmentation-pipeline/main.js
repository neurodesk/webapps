import { createNeuroWebapp } from '../../src/core/index.js';
import { PipelineRegistry } from '../../src/pipeline/index.js';
import { vesselboostPlugin } from '../../src/plugins/vesselboost/index.js';

const registry = new PipelineRegistry();
registry.registerPlugin(vesselboostPlugin);

const app = createNeuroWebapp({
  title: 'Step Pipeline',
  subtitle: 'Template',
  plugins: [vesselboostPlugin],
  sidebarSections: registry.require('vesselboost-step-pipeline').stages.map(stage => ({
    id: `stage-${stage.id}`,
    title: stage.label,
    content: `Worker command: ${stage.workerCommand}`
  }))
});

globalThis.templateApp = { app, registry };
