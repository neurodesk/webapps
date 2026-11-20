import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { writeSurfaceFiles } from '../../../packages/topofit/src/results.js';
import { REGIONS } from '../../../packages/topofit/src/cortex-regions.js';
import { automationArtifacts } from '../src/automation-results.js';

test('all generated surfaces including registration geometry survive artifact export unchanged', async () => {
  const vertices = {};
  const faces = {};
  for (const side of ['lh', 'rh']) {
    for (const name of ['white', 'pial', 'registration']) vertices[`${side}.${name}`] = Float32Array.of(0,0,0, 1,0,0, 0,1,0);
    faces[side] = Int32Array.of(0,1,2);
  }
  const files = writeSurfaceFiles(vertices, faces);
  const artifacts = automationArtifacts(files);
  assert.equal(artifacts.length, 8);
  for (const [index, artifact] of artifacts.entries()) {
    assert.equal(artifact.role, files[index].id.endsWith('-registration') ? 'registration' : 'surface');
    assert.equal(artifact.file.name, files[index].name);
    assert.deepEqual(await artifact.file.arrayBuffer(), files[index].bytes);
  }
});

test('variable patch geometry and metadata preserve independent result identities', () => {
  const artifacts = automationArtifacts([
    { id: 'LH01', name: 'LH01.mid.white', mediaType: 'application/vnd.freesurfer.surface', bytes: Uint8Array.of(1) },
    { id: 'surface-analysis', name: 'analysis.json', mediaType: 'application/json', bytes: new TextEncoder().encode('{}') },
    { id: 'lh-normals', name: 'normals.csv', mediaType: 'text/csv', bytes: new TextEncoder().encode('x,y,z') },
  ]);
  assert.deepEqual(artifacts.map(({ id, role }) => ({ id, role })), [{ id: 'lh01', role: 'surface' }, { id: 'surface-analysis', role: 'metadata' }, { id: 'lh-normals', role: 'table' }]);
});

test('mapped parcellations export as their own role', () => {
  const [artifact] = automationArtifacts([{ id: 'lh-wang2015-annot', name: 'lh.wang2015.annot', mediaType: 'application/vnd.freesurfer.annotation', bytes: Uint8Array.of(1) }]);
  assert.deepEqual({ id: artifact.id, role: artifact.role, name: artifact.file.name }, { id: 'lh-wang2015-annot', role: 'parcellation', name: 'lh.wang2015.annot' });
});

test('the region mask exports as its own role beside the QC images', () => {
  const artifacts = automationArtifacts([
    { id: 'patch-qc', name: 'topofit_patch_qc.nii', mediaType: 'application/nifti', bytes: Uint8Array.of(1) },
    { id: 'region-mask', name: 'topofit_region_mask.nii', mediaType: 'application/nifti', bytes: Uint8Array.of(1) },
  ]);
  assert.deepEqual(artifacts.map(({ id, role }) => [id, role]), [['patch-qc', 'qc'], ['region-mask', 'region-mask']]);
});

test('the automation patchRegion enum lists the whole cortex and every named region', async () => {
  const contract = JSON.parse(await readFile(new URL('../automation.json', import.meta.url)));
  const { patchRegion } = contract.operations.reconstruct.parameters;
  assert.deepEqual(patchRegion.enum, ['cortex', ...REGIONS.map(({ id }) => id)]);
  assert.equal(patchRegion.default, 'cortex');
  assert.equal(contract.operations.reconstruct.artifacts.parcellation.mediaType, 'application/vnd.freesurfer.annotation');
  assert.deepEqual(contract.operations.reconstruct.artifacts['region-mask'], { type: 'neuro:label-map', mediaType: 'application/nifti', space: 'input', minimum: 0, maximum: 1 });
});
