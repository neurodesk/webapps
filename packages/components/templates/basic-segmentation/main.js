import { createNeuroWebapp } from '../../src/core/index.js';
import { FileIOController } from '../../src/file-io/index.js';
import { PipelineExecutor } from '../../src/inference/index.js';

const app = createNeuroWebapp({
  title: 'Basic Segmentation',
  subtitle: 'Template',
  version: '0.1.0',
  sidebarSections: [{ id: 'inputSection', title: 'Input', content: 'Wire your upload UI here.' }]
});

const files = new FileIOController({
  mode: 'simple',
  updateOutput: message => app.console.log(message),
  onFileLoaded: file => app.refs.viewerInfoPrimary.textContent = file.name
});

const executor = new PipelineExecutor({
  workerUrl: './worker.js',
  updateOutput: message => app.console.log(message),
  setProgress: (value, text) => app.setProgress(value, text),
  onStageData: data => app.console.log(`Received stage: ${data.stage}`)
});

globalThis.templateApp = { app, files, executor };
