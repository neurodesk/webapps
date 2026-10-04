import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { generateTools, validateTool } from '../packages/desktop/neuroflow/generator.mjs';
import { qualifiers } from '../packages/desktop/neuroflow/qualifiers.mjs';
import { TEMPLATE } from '../apps/disconnectome/src/config.js';

async function tool(app, operationId) {
  const contract = JSON.parse(await readFile(new URL(`../apps/${app}/automation.json`, import.meta.url)));
  const manifest = JSON.parse(await readFile(new URL(`../apps/${app}/package.json`, import.meta.url)));
  return generateTools({ ...contract, appVersion: manifest.version })
    .find(value => value.extensions['neurodesk/automation'].operation === operationId);
}

test('SYNcro and disconnectome identify the same pinned FSL nonlinear sixth-generation template', async () => {
  const manifest = JSON.parse(await readFile(new URL('../models/syncro.manifest.json', import.meta.url)));
  const template = manifest.assets.find(asset => asset.filename === 'MNI152_T1_1mm_brain.nii.gz');
  assert.equal(template.sha256, '32d5be33460f995a5d305507053c8862c823d9ca6bfb543381308df14590f212');
  assert.equal(TEMPLATE.sha256, template.sha256);
  const normalize = await tool('syncro', 'normalize');
  const analyze = await tool('disconnectome', 'analyze');
  for (const declaration of [
    normalize.outputs['output_normalized-primary'], normalize.outputs['output_normalized-brain'],
    normalize.outputs['output_synthetic-brain'], normalize.outputs.output_lesion,
    normalize.outputs.output_pathological, analyze.inputs.input_lesion, analyze.inputs.input_anatomical,
  ]) {
    assert.equal(declaration.space, 'MNI152NLin6Asym');
    assert.equal(declaration.resolution, 1);
  }
  assert.equal(normalize.outputs['output_native-synthetic'].space, 'inputs.input_primary');
});

test('native input annotations do not exclude images already aligned to another frame', async () => {
  for (const [app, operationId] of [['brain-extraction', 'extract'], ['synthseg', 'segment'], ['synthsr', 'synthesize']]) {
    const generated = await tool(app, operationId);
    assert.equal(generated.inputs.input_image.space, undefined);
    assert.equal(generated.inputs.input_image.extensions['neurodesk/data'].space, 'native');
  }
  const brain = await tool('brain-extraction', 'extract');
  assert.equal(brain.outputs.output_brain.space, 'inputs.input_image');
  assert.equal(brain.outputs.output_mask.space, 'inputs.input_image');
});

test('TopoFit surfaces and QC inherit the anatomical image frame despite the optional ROI', async () => {
  const generated = await tool('topofit', 'reconstruct');
  assert.ok(generated.inputs.input_roi);
  assert.equal(generated.outputs.output_surface.space, 'inputs.input_image');
  assert.equal(generated.outputs.output_qc.space, 'inputs.input_image');
  assert.equal(generated.outputs.output_qc.resolution, undefined);
  assert.equal(generated.outputs.output_registration.space, undefined);
  assert.equal(generated.outputs.output_registration.extensions['neurodesk/data'].space, 'registration-sphere');
});

test('tract coordinates and VesselBoost regridding retain the input frame without asserting equal grids', async () => {
  const tracking = await tool('dwi2trx', 'tractography');
  assert.equal(tracking.outputs.output_tracts.space, 'inputs.input_image');
  const segmentation = await tool('vesselboost', 'segment');
  for (const role of ['vessels', 'preprocessed', 'brain-mask']) {
    assert.equal(segmentation.outputs[`output_${role}`].space, 'inputs.input_image');
    assert.equal(segmentation.outputs[`output_${role}`].resolution, undefined);
  }
});

test('selected atlases and conditional lesion references do not become globally shared spaces', async () => {
  const mapping = await tool('calmar', 'map-lesion');
  for (const declaration of [mapping.inputs.input_lesion, mapping.outputs.output_networkMap, mapping.outputs.output_thresholdMask]) {
    assert.equal(declaration.space, undefined);
    assert.equal(declaration.extensions['neurodesk/data'].space, 'atlas');
  }
  const normalization = await tool('syncro', 'normalize');
  for (const declaration of [normalization.inputs.input_lesion, normalization.inputs.input_pathological]) {
    assert.equal(declaration.space, undefined);
    assert.equal(declaration.extensions['neurodesk/data'].space, 'lesion-reference');
  }
});

test('subject-1mm separates inherited frame from output spacing and FreeSurfer label identity', async () => {
  const segmentation = await tool('synthseg', 'segment');
  assert.equal(segmentation.outputs.output_labels.space, 'inputs.input_image');
  assert.equal(segmentation.outputs.output_labels.resolution, 1);
  assert.equal(segmentation.outputs.output_labels.labelSystem, 'freesurfer');
  const synthetic = await tool('synthsr', 'synthesize');
  assert.equal(synthetic.outputs.output_synthetic.space, 'inputs.input_image');
  assert.equal(synthetic.outputs.output_synthetic.resolution, 1);
});

test('a collection of independently processed scans does not imply one common subject frame', async () => {
  const generated = await tool('musclemap', 'segment');
  assert.equal(generated.inputs.input_images.type, 'core:array<neuro:volume>');
  assert.equal(generated.inputs.input_images.space, undefined);
  assert.equal(generated.outputs.output_segmentation.space, undefined);
  assert.equal(generated.outputs.output_segmentation.extensions['neurodesk/data'].space, 'input');
});

test('app-specific mappings never guess a source role or template in an unrelated contract', () => {
  const image = { source: 'files', type: 'neuro:volume' };
  const operation = { inputs: { image, roi: { ...image, type: 'neuro:mask' } } };
  for (const space of ['atlas', 'analysis', 'MNI152-1mm', 'RAS-mm', 'scanner-RAS-mm', 'registration-sphere', 'input', 'subject-1mm', 'native']) {
    assert.deepEqual(qualifiers({ space }, 'artifacts', operation, { type: 'neuro:volume' }, { app: 'unrelated', operationId: 'run' }), {});
  }
});

test('displacement-field encodings do not widen to every NIfTI image through format alternatives', () => {
  const operation = { inputs: {} };
  const mapped = { type: 'neuro:transform', formats: ['displacement-field'] };
  assert.deepEqual(qualifiers({ type: 'neuro:displacement-field', formats: ['nifti'], space: 'fixed' }, 'artifacts', operation, mapped), {
    formats: ['displacement-field'],
  });
  assert.throws(() => qualifiers({ type: 'neuro:displacement-field', formats: ['json'] }, 'artifacts', operation, mapped), /vector NIfTI/);
});

test('registered encoding aliases preserve vendor formats without treating categories as encodings', () => {
  assert.deepEqual(qualifiers({ formats: ['gii', 'gifti', 'surface', 'bvals', 'bvecs', 'custom', 'constructor'] }, 'inputs', { inputs: {} }, { type: 'core:file' }), {
    formats: ['gifti', 'bval', 'bvec', 'neurodesk:custom', 'neurodesk:constructor'],
  });
});

test('all five qualifiers reject inheritance on an input declaration', async () => {
  const original = await tool('brain-extraction', 'extract');
  for (const key of ['formats', 'space', 'resolution', 'density', 'labelSystem']) {
    const generated = structuredClone(original);
    generated.inputs.input_extension = {
      type: 'neurodesk:custom', description: 'Vendor input', [key]: 'inputs.input_image',
    };
    assert.throws(() => validateTool(generated), /inheritance is only allowed on outputs/);
  }
});

test('inherited qualifiers apply to the source input type as defined by the upstream schema', async () => {
  const original = await tool('brain-extraction', 'extract');
  for (const [key, inputType, outputType] of [
    ['space', 'core:string', 'neuro:volume'],
    ['space', 'neuro:transform', 'neuro:volume'],
    ['resolution', 'neuro:surface', 'neuro:volume'],
    ['density', 'neuro:volume', 'neuro:surface'],
    ['labelSystem', 'neuro:volume', 'neuro:label-map'],
    ['formats', 'core:json', 'core:file'],
  ]) {
    const generated = structuredClone(original);
    generated.inputs.input_source = { type: inputType, description: 'Source' };
    generated.outputs.output_inherited = { type: outputType, description: 'Inherited output', [key]: 'inputs.input_source' };
    assert.throws(() => validateTool(generated), new RegExp(`${key} does not apply to input input_source`));
  }
});

test('the generator rejects unsupported scalar output inheritance from a collection', async () => {
  const generated = await tool('brain-extraction', 'extract');
  generated.inputs.input_image.type = 'core:array<neuro:volume>';
  assert.throws(() => validateTool(generated), /generator does not support a scalar output inheriting space from collection/);
});

test('output inheritance may obtain an absent input qualifier by runtime inspection', async () => {
  const generated = await tool('brain-extraction', 'extract');
  generated.inputs.input_source = { type: 'neuro:label-map', description: 'Inspected source' };
  generated.outputs.output_inherited = {
    type: 'neuro:label-map', description: 'Inherited output', formats: 'inputs.input_source', space: 'inputs.input_source',
    resolution: 'inputs.input_source', labelSystem: 'inputs.input_source',
  };
  assert.doesNotThrow(() => validateTool(generated));
  generated.outputs.output_inherited.type = 'core:array<neuro:label-map>';
  assert.doesNotThrow(() => validateTool(generated));
});
