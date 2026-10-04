import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  APP_VERSION,
  MODEL_RELEASES,
  MODELS,
  getLabelSpace
} from '../web/js/app/model-catalog.generated.js';

test('generated contracts are current', () => {
  execFileSync(process.execPath, ['scripts/generate_model_contracts.mjs', '--check'], {
    cwd: new URL('..', import.meta.url),
    stdio: 'pipe'
  });
});

test('catalog application version matches package.json', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(APP_VERSION, packageJson.version);
});

test('upstream reference cases pin source chunk semantics and artifact digests', async () => {
  const manifest = JSON.parse(await readFile(
    new URL('../model-sources/upstream-reference-cases.json', import.meta.url),
    'utf8'
  ));
  assert.equal(manifest.schemaVersion, 1);
  assert.deepEqual(
    manifest.cases.map(reference => [reference.id, reference.sourceChunkSize, reference.overlap]),
    [
      ['vhp-neck', 43, 0.5],
      ['vhp-chest', 34, 0.5],
      ['vhp-pelvis', 5, 0],
      ['vhp-knee', 5, 0],
      ['vhp-ankle', 5, 0]
    ]
  );
  for (const reference of manifest.cases) {
    assert.match(reference.inputSha256, /^[0-9a-f]{64}$/);
    assert.match(reference.referenceSha256, /^[0-9a-f]{64}$/);
  }
});

test('downloadable parity cases pin immutable files, model and provenance', async () => {
  const manifest = JSON.parse(await readFile(
    new URL('../model-sources/parity-reference.json', import.meta.url), 'utf8'
  ));
  assert.equal(manifest.repository, 'neurodeskorg/webapps');
  assert.match(manifest.revision, /^[0-9a-f]{40}$/);
  const model = MODEL_RELEASES.find(item => item.id === 'wholebody' && item.modelVersion === '1.4');
  assert.equal(manifest.modelSha256, model.asset.sha256);
  const files = new Map(manifest.files.map(file => [file.path, file]));
  assert.equal(files.size, manifest.files.length);
  for (const file of files.values()) {
    assert.ok(Number.isSafeInteger(file.bytes) && file.bytes > 0);
    assert.match(file.sha256, /^[0-9a-f]{64}$/);
    assert.ok(!file.path.startsWith('/') && !file.path.split('/').includes('..'));
  }
  for (const reference of manifest.cases) {
    assert.equal(files.get(reference.input)?.sha256, reference.inputSha256);
    assert.equal(files.get(reference.reference)?.sha256, reference.referenceSha256);
    assert.ok(files.has(reference.provenance));
    assert.ok(Number.isInteger(reference.sourceChunkSize) && reference.sourceChunkSize > 0);
    assert.ok(reference.overlap >= 0 && reference.overlap < 1);
    assert.ok(reference.authority.startsWith('unmodified-upstream') || reference.authority === 'bounded-channel-inversion');
  }
});

test('v1.4 whole-body contract matches the official network and labels', () => {
  const model = MODEL_RELEASES.find(candidate => candidate.id === 'wholebody' && candidate.modelVersion === '1.4');
  assert.ok(model);
  assert.equal(model.status, 'active');
  assert.equal(model.numClasses, 114);
  assert.equal(model.network.numResUnits, 2);
  assert.deepEqual(model.roiSize, [256, 256]);
  assert.equal(model.preprocessing.overlapDefault, 0.9);
  assert.equal(model.asset.precision, 'fp32');
  assert.match(model.asset.url, /musclemap-model-v1\.4-fp32\/musclemap-wholebody-v1\.4-fp32\.onnx$/);
  assert.equal(model.asset.parts.length, 5);
  assert.equal(model.asset.parts.reduce((sum, part) => sum + part.bytes, 0), model.asset.bytes);

  const labelSpace = getLabelSpace('musclemap-wholebody-v1.4');
  assert.equal(labelSpace.labels.length, 114);
  assert.deepEqual(
    labelSpace.labels.slice(86).map(label => [label.index, label.value, label.anatomy, label.side]),
    [
      [86, 7231, 'patella', 'left'],
      [87, 7232, 'patella', 'right'],
      [88, 8101, 'tibialis anterior', 'left'],
      [89, 8102, 'tibialis anterior', 'right'],
      [90, 8111, 'tibialis posterior', 'left'],
      [91, 8112, 'tibialis posterior', 'right'],
      [92, 8121, 'peroneus longus', 'left'],
      [93, 8122, 'peroneus longus', 'right'],
      [94, 8131, 'soleus', 'left'],
      [95, 8132, 'soleus', 'right'],
      [96, 8141, 'medial gastrocnemius', 'left'],
      [97, 8142, 'medial gastrocnemius', 'right'],
      [98, 8151, 'lateral gastrocnemius', 'left'],
      [99, 8152, 'lateral gastrocnemius', 'right'],
      [100, 8161, 'tibia', 'left'],
      [101, 8162, 'tibia', 'right'],
      [102, 8171, 'fibula', 'left'],
      [103, 8172, 'fibula', 'right'],
      [104, 8181, 'flexor hallucis longus', 'left'],
      [105, 8182, 'flexor hallucis longus', 'right'],
      [106, 8191, 'extensor digitorum / hallucis longus', 'left'],
      [107, 8192, 'extensor digitorum / hallucis longus', 'right'],
      [108, 8201, 'flexor digitorum longus', 'left'],
      [109, 8202, 'flexor digitorum longus', 'right'],
      [110, 8211, 'popliteus', 'left'],
      [111, 8212, 'popliteus', 'right'],
      [112, 8221, 'plantaris', 'left'],
      [113, 8222, 'plantaris', 'right']
    ]
  );
});

test('v1.4 is the default whole-body model and v1.3 remains selectable as legacy', () => {
  assert.equal(MODELS.length, 7);
  assert.equal(MODELS[0].modelVersion, '1.4');

  const wholeBodyModels = MODELS.filter(model => model.id === 'wholebody');
  assert.deepEqual(
    wholeBodyModels.map(model => [model.modelVersion, model.status, model.legacy]),
    [
      ['1.4', 'active', false],
      ['1.3', 'legacy', true]
    ]
  );
  assert.equal(wholeBodyModels[0].preprocessing.overlapDefault, 0.9);
  assert.equal(wholeBodyModels[1].preprocessing.overlapDefault, 0.5);
  assert.notEqual(wholeBodyModels[0].labelSpaceId, wholeBodyModels[1].labelSpaceId);
  assert.ok(MODELS.filter(model => model.status !== 'active').every(model => model.legacy));
});
