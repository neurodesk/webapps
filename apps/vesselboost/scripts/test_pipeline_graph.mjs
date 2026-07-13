#!/usr/bin/env node --no-warnings

import assert from 'node:assert/strict';
import { PipelineGraph } from '../web/js/modules/pipeline/PipelineGraph.js';

function fakeFile(name) {
  return { name };
}

{
  const graph = new PipelineGraph();
  graph.loadSource({ file: fakeFile('source.nii'), digest: 'source-a' });

  graph.setNodeRunning('downsample', { params: { factor: 2 } });
  graph.recordArtifact('downsample', { stage: 'downsample', file: fakeFile('downsample-2x.nii') });
  graph.markNodeComplete('downsample', { params: { factor: 2 } });
  graph.setNodeRunning('n4');
  graph.recordArtifact('n4', { stage: 'n4', file: fakeFile('n4.nii') });
  graph.markNodeComplete('n4');
  graph.setNodeRunning('denoise', { params: { method: 'bilateral' } });
  graph.recordArtifact('denoise', { stage: 'nlm', file: fakeFile('nlm.nii') });
  graph.markNodeComplete('denoise');
  graph.setNodeRunning('inference', { params: { threshold: 0.1 } });
  graph.recordArtifact('inference', { stage: 'segmentation', file: fakeFile('seg.nii') });
  graph.markNodeComplete('inference');

  assert.deepEqual(graph.getStageArtifactsInOrder(), ['downsample', 'n4', 'nlm', 'segmentation']);

  const invalidated = graph.invalidateFrom('downsample', { includeSelf: true });
  assert.deepEqual(
    invalidated.nodes.sort(),
    ['bet', 'denoise', 'downsample', 'inference', 'n4'].sort(),
    'downsample changes must clear every downstream branch'
  );
  assert.deepEqual(
    invalidated.stages.sort(),
    ['downsample', 'n4', 'nlm', 'segmentation'].sort(),
    'downsample invalidation must remove active stage artifacts'
  );
  assert.equal(graph.getStageArtifact('segmentation'), null);
  assert.equal(graph.getNodeStatus('n4'), 'pending');
}

{
  const graph = new PipelineGraph();
  graph.loadSource({ file: fakeFile('source.nii'), digest: 'source-a' });
  graph.setNodeRunning('downsample', { params: { factor: 2 } });
  graph.recordArtifact('downsample', { stage: 'downsample', file: fakeFile('downsample-2x.nii') });
  graph.markNodeComplete('downsample', { params: { factor: 2 } });
  graph.markNodeSkipped('downsample', { skipped: true });
  assert.equal(graph.getNodeStatus('downsample'), 'skipped');
  assert.equal(graph.getStageArtifact('downsample'), null,
    'skip downsample must make the active downsample artifact disappear');
}

{
  const graph = new PipelineGraph();
  graph.loadSource({ file: fakeFile('source.nii'), digest: 'source-a' });
  graph.setNodeRunning('n4');
  graph.recordArtifact('n4', { stage: 'n4', file: fakeFile('n4.nii') });
  graph.markNodeComplete('n4');
  graph.setNodeRunning('denoise', { params: { method: 'bilateral' } });
  graph.recordArtifact('denoise', { stage: 'nlm', file: fakeFile('nlm.nii') });
  graph.markNodeComplete('denoise');
  graph.setNodeRunning('bet', { params: { method: 'synthstrip' } });
  graph.recordArtifact('bet', { stage: 'bet', file: fakeFile('bet.nii') });
  graph.recordArtifact('bet', { stage: 'brainmask', file: fakeFile('brainmask.nii') });
  graph.markNodeComplete('bet');
  graph.setNodeRunning('inference', { params: { model: 'manual', threshold: 0.1 } });
  graph.recordArtifact('inference', { stage: 'segmentation', file: fakeFile('seg.nii') });
  graph.markNodeComplete('inference');

  const invalidated = graph.invalidateFrom('bet', { includeSelf: true });
  assert.deepEqual(invalidated.stages.sort(), ['bet', 'brainmask', 'segmentation'].sort(),
    'brain-mask changes must invalidate final segmentation without clearing N4/denoise');
  assert.ok(graph.getStageArtifact('n4'));
  assert.ok(graph.getStageArtifact('nlm'));
}

console.log('pipeline-graph OK: DAG invalidation + skip-as-identity behavior.');
