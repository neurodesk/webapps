import { PipelineExecutor, StepPipelineState } from '@neurodesk/webapp-components';
import { VERSION } from '../app/config.js';
import {
  analysisVolumeSpace,
  getSpatialMetadata,
  readNiftiSpatialMetadata,
  spatialGridId,
  tagSpatialFile,
  VOLUME_SPACES,
} from '../modules/spatial-file.js';

export class VesselBoostPipeline extends PipelineExecutor {
  constructor(options = {}) {
    super({
      ...options,
      workerUrl: `js/inference-worker.js?v=${VERSION}`,
      workerType: 'module',
      version: VERSION,
      steps: ['load', 'downsample', 'n4', 'bet', 'denoise', 'inference'],
      hiddenArtifacts: {
        n4State: { preN4Data: null },
        betState: { brainMask: null, preBETMask: null },
        denoiseState: { preDenoiseData: null },
        segmentationState: { segLabelsRAS: null, segMinComponentSize: 10 },
      },
    });
    this.graph = new StepPipelineState();
    this.currentStepParams = {};
    this.sourceSpatial = null;
    this.brainMaskOverlayFile = null;
    this.checkpointExtension = {
      captureHost: () => ({
        graph: this.graph.snapshot(),
        currentStepParams: clone(this.currentStepParams),
        sourceSpatial: clone(this.sourceSpatial),
      }),
      extendRestoreRequest: async ({ results }) => ({
        downsampleResultData: results.downsample?.file ? await results.downsample.file.arrayBuffer() : null,
        n4ResultData: results.n4?.file ? await results.n4.file.arrayBuffer() : null,
        denoiseResultData: results.nlm?.file ? await results.nlm.file.arrayBuffer() : null,
      }),
      restoreHost: snapshot => {
        this.graph.restore(snapshot.graph);
        this.currentStepParams = clone(snapshot.currentStepParams || {});
        this.sourceSpatial = clone(snapshot.sourceSpatial || null);
      },
    };
  }

  getPipelineGraph() { return this.graph; }

  async loadVolume(inputData) {
    this.graph.setNodeRunning('load', { params: {} });
    return super.loadVolume(inputData);
  }

  downsample(factor) {
    this.invalidateFromStep('downsample', { includeSelf: true });
    this.currentStepParams.downsample = { factor };
    this.graph.setNodeRunning('downsample', { params: this.currentStepParams.downsample });
    const inputData = this.inputVolumeBuffer?.slice(0);
    return this.executeCommand(inputData ? 'downsample-from-input' : 'downsample',
      inputData ? { inputData, factor } : { factor },
      { step: 'downsample', checkpoint: false });
  }

  skipDownsample() {
    this.invalidateFromStep('downsample', { includeSelf: true });
    this.currentStepParams.downsample = { skipped: true };
    this.graph.markNodeSkipped('downsample', this.currentStepParams.downsample);
    const inputData = this.inputVolumeBuffer?.slice(0);
    return this.executeCommand('skip-downsample', inputData ? { inputData } : {}, {
      step: 'downsample', checkpoint: false, skipped: true,
    });
  }

  runN4() { return this.runGraphStep('n4', 'run-n4', {}, { skipped: false }); }
  skipN4() { return this.skipGraphStep('n4', 'skip-n4'); }

  runBET(fractionalIntensity, method = 'bet', modelBaseUrl) {
    return this.runGraphStep('bet', 'run-bet', { fractionalIntensity, method, modelBaseUrl });
  }

  skipBET() { return this.skipGraphStep('bet', 'skip-bet'); }
  applyBrainMask() { return this.executeCommand('apply-brain-mask', {}, { checkpoint: false }); }
  dilateBrainMask(iterations = 1) { return this.executeCommand('dilate-brain-mask', { iterations }, { checkpoint: false }); }
  erodeBrainMask(iterations = 1) { return this.executeCommand('erode-brain-mask', { iterations }, { checkpoint: false }); }
  runDenoise(method) { return this.runGraphStep('denoise', 'run-denoise', { method }); }
  skipDenoise() { return this.skipGraphStep('denoise', 'skip-denoise'); }
  runInference(settings) { return this.runGraphStep('inference', 'run-inference', settings); }

  runGraphStep(step, request, data, params = data) {
    this.invalidateFromStep(step, { includeSelf: true });
    this.currentStepParams[step] = clone(params);
    this.graph.setNodeRunning(step, { params: this.currentStepParams[step] });
    return this.executeCommand(request, data, { step });
  }

  skipGraphStep(step, request) {
    this.invalidateFromStep(step, { includeSelf: true });
    this.currentStepParams[step] = { skipped: true };
    this.graph.markNodeSkipped(step, this.currentStepParams[step]);
    return this.executeCommand(request, {}, { step, checkpoint: false, skipped: true });
  }

  async resetWorkerState() {
    await super.resetWorkerState();
    this.graph.reset();
    this.currentStepParams = {};
    this.sourceSpatial = null;
    this.brainMaskOverlayFile = null;
  }

  invalidateFromStep(step, { includeSelf = false } = {}) {
    const invalidated = this.graph.invalidateFrom(step, { includeSelf });
    for (const stage of invalidated.stages) delete this.results[stage];
    this.stageOrder = this.stageOrder.filter(stage => !invalidated.stages.includes(stage));
    for (const node of invalidated.nodes) {
      if (this.stepStatus[node] !== undefined && node !== 'load') this.stepStatus[node] = 'pending';
    }
    return invalidated;
  }

  handleStageData(data) {
    if (!this.stageOrder.includes(data.stage)) this.stageOrder.push(data.stage);
    const file = new File([data.niftiData], `${data.stage}.nii`, { type: 'application/octet-stream' });
    const spatial = this.tagStageFile(file, data.stage, data.niftiData);
    this.results[data.stage] = { file, description: data.description, kind: 'nifti', spatial, raw: data, editable: data.stage === 'segmentation' };
    const nodeId = this.graph.getNodeForStage(data.stage);
    this.graph.recordArtifact(nodeId, { stage: data.stage, role: data.stage, file, description: data.description, spatial });
    if (data.stage === 'segmentation') {
      this.stepStatus.inference = 'complete';
      this.graph.markNodeComplete('inference', { mode: 'run', params: this.currentStepParams.inference || {} });
    }
    Promise.resolve(this.onStageData(data, this.results[data.stage])).catch(error => {
      this.updateOutput(`Error displaying ${data.stage}: ${error.message}`);
    });
  }

  handleStepComplete(step) {
    if (this.graph.nodes?.has(step)) {
      this.graph.markNodeComplete(step, {
        mode: this.stepStatus[step] === 'skipped' ? 'skip' : 'run',
        params: this.currentStepParams[step] || {},
      });
    }
    super.handleStepComplete(step);
  }

  handleMessage(message) {
    if (message.type === 'brain-mask-overlay') {
      this.handleBrainMaskOverlay(message);
      return;
    }
    super.handleMessage(message);
  }

  handleBrainMaskOverlay(data) {
    const file = new File([data.niftiData], 'brain-mask.nii', { type: 'application/octet-stream' });
    this.brainMaskOverlayFile = file;
    const spatial = this.tagStageFile(file, 'brainmask', data.niftiData);
    if (!this.stageOrder.includes('brainmask')) this.stageOrder.push('brainmask');
    this.results.brainmask = { file, description: 'Brain mask', kind: 'nifti', spatial, raw: data, editable: true };
    this.graph.recordArtifact('bet', { stage: 'brainmask', role: 'brainmask', file, description: 'Brain mask overlay', spatial });
    this.onBrainMaskOverlay?.(file);
  }

  setSourceFile(file, inputData) {
    const spatial = readNiftiSpatialMetadata(inputData);
    this.sourceSpatial = spatial;
    tagSpatialFile(file, {
      space: spatial ? VOLUME_SPACES.SOURCE_NATIVE : undefined,
      role: 'source', sourceStage: 'input', dims: spatial?.dims, affine: spatial?.affine,
    });
    this.graph.loadSource({
      file,
      digest: this.bufferDigest(inputData),
      spatial: { space: spatial ? VOLUME_SPACES.SOURCE_NATIVE : undefined, dims: spatial?.dims, affine: spatial?.affine },
    });
  }

  // The editor draws on the result's own grid, but NiiVue rewrites a qform-only header with an sform, which readNiftiSpatialMetadata would read as another grid.
  replaceWithEdit(stage, file, original) {
    const result = this.results[stage];
    tagSpatialFile(file, getSpatialMetadata(result.file));
    this.results[stage] = { ...result, file, original: result.original ?? original, edited: true };
    return this.results[stage];
  }

  tagStageFile(file, stage, niftiData) {
    const spatial = readNiftiSpatialMetadata(niftiData);
    const gridId = spatialGridId(spatial || {});
    const sameAsSource = sameSpatial(spatial, this.sourceSpatial);
    const metadata = {
      space: stage === 'input' || sameAsSource ? VOLUME_SPACES.SOURCE_NATIVE : analysisVolumeSpace(gridId),
      role: stage, sourceStage: stage, dims: spatial?.dims, affine: spatial?.affine,
    };
    tagSpatialFile(file, metadata);
    return metadata;
  }

  bufferDigest(buffer) {
    if (!(buffer instanceof ArrayBuffer)) return `source:${Date.now()}`;
    const bytes = new Uint8Array(buffer);
    let hash = 0;
    const stride = Math.max(1, Math.floor(bytes.length / 4096));
    for (let index = 0; index < bytes.length; index += stride) hash = ((hash << 5) - hash + bytes[index]) | 0;
    hash = ((hash << 5) - hash + bytes.length) | 0;
    return Math.abs(hash).toString(36);
  }
}

function sameSpatial(left, right) {
  if (!left?.dims || !right?.dims) return false;
  if (left.dims.length !== right.dims.length || left.dims.some((value, index) => Number(value) !== Number(right.dims[index]))) return false;
  if (!left.affine || !right.affine) return true;
  for (let row = 0; row < 4; row++) {
    for (let column = 0; column < 4; column++) {
      if (Math.abs(Number(left.affine[row]?.[column]) - Number(right.affine[row]?.[column])) > 1e-3) return false;
    }
  }
  return true;
}

function clone(value) {
  if (value == null || typeof value !== 'object') return value;
  if (value instanceof ArrayBuffer) return value.slice(0);
  if (ArrayBuffer.isView(value)) return new value.constructor(value);
  if (Array.isArray(value)) return value.map(clone);
  return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, clone(nested)]));
}
