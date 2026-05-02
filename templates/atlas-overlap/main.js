import { createNeuroWebapp } from '../../src/core/index.js';
import { PipelineRegistry } from '../../src/pipeline/index.js';
import { lesionNetworkMappingPlugin } from '../../src/plugins/lesion-network-mapping/index.js';

const registry = new PipelineRegistry();
registry.registerPlugin(lesionNetworkMappingPlugin);

const app = createNeuroWebapp({
  title: 'Atlas Overlap',
  subtitle: 'Template',
  plugins: [lesionNetworkMappingPlugin],
  sidebarSections: [{ id: 'overlap', title: 'Overlap', content: 'Upload lesion mask and run atlas overlap.' }]
});

globalThis.templateApp = { app, registry };
