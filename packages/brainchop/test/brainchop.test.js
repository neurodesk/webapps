import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  findModel,
  labelColormap,
  labelNamesMap,
  MODELS,
  outputNames,
  stemFor,
  TISSUE_STAGES,
  validateOptions,
} from '../src/models.js';
import { checkInstallation, downloadModels } from '../src/node.js';

const BIN = fileURLToPath(new URL('../bin/brainchop.js', import.meta.url));

test('MODELS catalog exposes all four v4.0 models with @brainchop/core colormaps', () => {
  assert.deepEqual(MODELS.map((m) => m.id), ['mindmap', 'mindmap-fast', 'mindsnap', 'tissue-fractions']);
  assert.equal(findModel('mindsnap')?.classes, 104);
  assert.equal(findModel('unknown'), null);
  for (const model of MODELS.filter((m) => m.kind === 'labels')) {
    const lut = labelColormap(model.id);
    assert.ok(lut, model.id);
    assert.equal(lut.labels.length, model.classes);
    assert.equal(lut.A[0], 0);
    assert.equal(lut.A[1], 255);
    assert.equal(Object.keys(labelNamesMap(model.id)).length, model.classes);
  }
  assert.equal(labelColormap('tissue-fractions'), null);
  assert.equal(TISSUE_STAGES.length, 4);
});

test('stemFor, outputNames, and validateOptions enforce model and flag contracts', () => {
  assert.equal(stemFor('sub-01_T1w.nii.gz'), 'sub-01_T1w');
  assert.deepEqual(outputNames('sub-01_T1w.nii.gz', 'mindmap'), { segmentation: 'sub-01_T1w_mindmap.nii' });
  assert.deepEqual(outputNames('sub-01_T1w.nii.gz', 'tissue-fractions'), {
    gm: 'sub-01_T1w_gm.nii',
    wm: 'sub-01_T1w_wm.nii',
    csf: 'sub-01_T1w_csf.nii',
    brain: 'sub-01_T1w_brain.nii',
  });
  assert.equal(validateOptions({ model: 'mindsnap', saveConform: true }).model.id, 'mindsnap');
  assert.throws(() => validateOptions({ model: 'bogus' }), /Unknown model/);
  assert.throws(
    () => validateOptions({ model: 'tissue-fractions', legacyCleanup: true }),
    /legacyCleanup is only supported for label models/,
  );
});

test('checkInstallation, downloadModels, and CLI --help/self-check work offline', async () => {
  const info = await checkInstallation();
  assert.equal(info.ok, true);
  assert.equal(info.executable, process.execPath);
  assert.equal(info.node, process.version);
  assert.equal(info.backend, 'cpu');
  assert.equal(info.corePackage, '@brainchop/core');
  assert.equal(info.modelsEmbedded, true);

  const dl = await downloadModels({ cacheDir: '/tmp/unused' });
  assert.equal(dl.count, 0);
  assert.equal(dl.modelsEmbedded, true);

  const help = execFileSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
  assert.match(help, /Usage: brainchop/);
  assert.match(help, /tissue-fractions/);

  const selfOut = execFileSync(process.execPath, [BIN, 'self-check'], { encoding: 'utf8' });
  const parsed = JSON.parse(selfOut.trim());
  assert.equal(parsed.ok, true);
  assert.equal(parsed.executable, process.execPath);
});
