import assert from 'node:assert/strict';
import test from 'node:test';
import { PipelineExecutor } from '../../../packages/components/src/inference/PipelineExecutor.js';
import { clearResultsAfterEditing, isEditableStage, replaceWithEdit, stageLabel } from '../web/js/app/mask-edit.js';

function executorWith(stages) {
  const executor = new PipelineExecutor({ workerUrl: 'unused.js' });
  for (const stage of stages) executor.handleStageData({ stage, niftiData: new Uint8Array([1, 2, 3]).buffer, description: stage });
  return executor;
}

test('only the consensus marker mask is editable', () => {
  assert.equal(isEditableStage('consensus'), true);
  for (const stage of ['input', 'model1', 'model2', 'model3', 'model4', 'avgProb']) assert.equal(isEditableStage(stage), false, stage);
});

test('applying an edit replaces the downloaded file and keeps the pipeline original', () => {
  const executor = executorWith(['avgProb', 'consensus']);
  const pipelineFile = executor.getResult('consensus').file;
  const first = new File([new Uint8Array([9])], pipelineFile.name);
  replaceWithEdit(executor, 'consensus', first, pipelineFile);
  const second = new File([new Uint8Array([8])], pipelineFile.name);
  const result = replaceWithEdit(executor, 'consensus', second, first);
  assert.equal(executor.getResult('consensus').file, second);
  assert.equal(result.original, pipelineFile);
  assert.equal(result.edited, true);
  assert.equal(result.description, 'consensus');
  assert.equal(stageLabel('Consensus', result), 'Consensus (edited)');
  assert.equal(stageLabel('Avg Prob', executor.getResult('avgProb')), 'Avg Prob');
});

test('clearing results closes the open edit session before the results go', async () => {
  const executor = executorWith(['consensus']);
  const calls = [];
  const editor = { cancel: async () => calls.push(['cancel', Object.keys(executor.results).length]) };
  await clearResultsAfterEditing(editor, executor);
  assert.deepEqual(calls, [['cancel', 1]]);
  assert.deepEqual(executor.results, {});
});
