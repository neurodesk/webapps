import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { decodeVolume } from '../src/nifti.js';
import { decodeFcPack } from '../src/fc-weighted-sum.js';
import { writeNifti1 } from '../src/nifti-writer.js';
import { loadAsset, MODEL_ASSETS } from '../src/node.js';

const { values } = parseArgs({ options: { executable: { type: 'string' } } });
const command = values.executable
  ? [values.executable]
  : [process.execPath, resolve('packages/calmar/bin/calmar.js')];
const modelDir =
  process.env.NEURODESK_CALMAR_MODEL_DIR ||
  (values.executable && join(await realpath(values.executable), '..', 'models'));
assert.ok(modelDir, 'Set NEURODESK_CALMAR_MODEL_DIR or pass --executable for bundled models.');
assert.ok((await stat(modelDir)).isDirectory(), 'CALMAR model directory must be a directory.');
const work = await mkdtemp(join(tmpdir(), 'calmar-cli-check-'));
const run = (args) => {
  const result = spawnSync(command[0], [...command.slice(1), ...args], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, NEURODESK_OFFLINE: '1' },
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
};

const pinned = async (url, sha256, filename) => {
  const cache = join(tmpdir(), 'calmar-validation', sha256, filename);
  let bytes = await readFile(cache).catch(() => null);
  const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
  if (!bytes || hash(bytes) !== sha256) {
    const response = await fetch(url);
    assert.ok(response.ok, `Reference HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(hash(bytes), sha256);
    await mkdir(join(cache, '..'), { recursive: true });
    await writeFile(cache, bytes);
  }
  return { path: cache, bytes };
};

const dice = (a, b) => {
  assert.equal(a.length, b.length);
  let intersection = 0;
  let count = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] && b[i]) intersection++;
    count += Number(a[i] > 0) + Number(b[i] > 0);
  }
  return count ? (2 * intersection) / count : 1;
};

const reference = JSON.parse(await readFile(new URL('./reference.manifest.json', import.meta.url)));
const example = await pinned(reference.input.url, reference.input.sha256, 'stroke_T1.nii.gz');
const prepared = join(work, 'prepared');
const provenance = run(['prepare', example.path, prepared, '--threads', '4']);
assert.equal(provenance.requiresReview, true);
const candidate = decodeVolume(await readFile(join(prepared, 'candidate-lesion.nii')));
const browserOutput = join(work, 'browser');
const browserHome = join(work, 'browser-home');
await mkdir(browserHome);
const recorded = spawnSync(
  process.execPath,
  [resolve('packages/calmar/validation/browser-reference.mjs'), browserOutput],
  {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    env: {
      ...process.env,
      HOME: browserHome,
      USERPROFILE: browserHome,
      XDG_CACHE_HOME: browserHome,
      XDG_CONFIG_HOME: browserHome,
      XDG_DATA_HOME: browserHome,
      CALMAR_REFERENCE_INPUT: example.path,
      CALMAR_REVIEWED_INPUT: join(prepared, 'candidate-lesion.nii'),
      NEURODESK_CALMAR_MODEL_DIR: modelDir,
    },
  }
);
assert.equal(recorded.status, 0, recorded.stderr + recorded.stdout);
const browserCandidate = decodeVolume(await readFile(join(browserOutput, 'candidate-lesion.nii')));
assert.deepEqual(candidate.dims, browserCandidate.dims);
const agreement = dice(candidate.data, browserCandidate.data);
// The tighter runtime gate allows less than three times the measured browser/native disagreement.
assert.ok(
  agreement >= reference.minimumCandidateDice,
  `Candidate Dice ${agreement} < runtime gate ${reference.minimumCandidateDice}`
);
const truth = decodeVolume(
  await readFile(
    new URL('../../../apps/calmar/tests/fixtures/ds004884-mini/lesion_mask.nii.gz', import.meta.url)
  )
);
const scientificDice = dice(candidate.data, truth.data);
assert.ok(
  scientificDice >= reference.minimumScientificDice,
  `Stroke Dice ${scientificDice} < existing scientific gate ${reference.minimumScientificDice}`
);
console.log(`PASS independent real-stroke truth Dice ${scientificDice}`);
console.log(
  `PASS pinned example preparation stops for review; browser candidate Dice ${agreement}`
);

// Independent identity-channel reference from test_fc_weighted_sum_parity.mjs:
// a lesion entirely in Visual must reproduce the existing Visual t-map.
const phantom = resolve('apps/calmar/tests/fixtures/lnm-phantom/lesion-mni2.nii.gz');
const mapped = join(work, 'yeo');
run(['map', phantom, mapped, '--reviewed', '--atlas', 'yeo7']);
const local = (id) =>
  loadAsset(
    MODEL_ASSETS.find((asset) => asset.id === id),
    { cacheDir: modelDir || undefined, offline: true }
  );
const index = JSON.parse(await local('yeo7-fc-pack-index'));
const bytes = await local('yeo7-fc-pack');
const visual = decodeFcPack(
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  index
).tMaps[0];
const actual = decodeVolume(await readFile(join(mapped, 'lnm-network-map.nii')));
let maxDifference = 0;
for (let i = 0; i < visual.length; i++)
  maxDifference = Math.max(maxDifference, Math.abs(visual[i] - actual.data[i]));
assert.ok(maxDifference <= reference.maximumFcError, `Visual channel max error ${maxDifference}`);
assert.match(await readFile(join(mapped, 'lnm-overlap.csv'), 'utf8'), /Visual,64,1\.0000/);
console.log(`PASS independent Visual FC identity reference, max error ${maxDifference}`);

// Exercise the default sharded atlas with a mask wholly in the first parcel.
const atlas = decodeVolume(await local('schaefer400-7n-2mm'));
const lesion = Uint8Array.from(atlas.data, (value) => (value === 1 ? 1 : 0));
const path = join(work, 'parcel-lesion.nii');
await writeFile(
  path,
  Buffer.from(
    writeNifti1(lesion, { dims: atlas.dims, spacing: atlas.spacing, affine: atlas.affine.flat() })
  )
);
const schaefer = join(work, 'schaefer');
const report = run(['map', path, schaefer, '--reviewed']);
assert.equal(report.atlas, 'schaefer400');
assert.equal(report.weights.filter((value) => value !== 0).length, 1);
assert.equal(
  report.weights.find((value) => value !== 0),
  1
);
const scalar = decodeVolume(await readFile(join(schaefer, 'lnm-network-map.nii')));
const shardIndex = JSON.parse(await local('schaefer400-fc-pack-development-n155-4mm-index'));
const firstShard = shardIndex.shards[0];
const shardBytes = await local('schaefer400-fc-pack-development-n155-4mm-001-040');
const firstChannel = decodeFcPack(
  shardBytes.buffer.slice(shardBytes.byteOffset, shardBytes.byteOffset + shardBytes.byteLength),
  {
    ...shardIndex,
    ...firstShard,
    shape: [firstShard.channelLabels.length, ...shardIndex.shape.slice(1)],
    channelLabels: Object.fromEntries(
      firstShard.channelLabels.map((label) => [label, shardIndex.channelLabels[label]])
    ),
  }
).tMaps[0];
assert.equal(scalar.data.length, firstChannel.length);
let shardDifference = 0;
for (let i = 0; i < scalar.data.length; i++)
  shardDifference = Math.max(shardDifference, Math.abs(scalar.data[i] - firstChannel[i]));
assert.ok(
  shardDifference <= reference.maximumFcError,
  `Schaefer channel identity error ${shardDifference}`
);
const threshold = decodeVolume(await readFile(join(schaefer, 'lnm-network-map-thresh.nii')));
assert.ok(threshold.data.every((value) => value === 0 || value === 1));
console.log(
  `PASS independent Schaefer channel identity reference, max error ${shardDifference}; binary threshold`
);

const native = join(work, 'native-to-atlas');
run([
  'map',
  join(prepared, 'candidate-lesion.nii'),
  native,
  '--reviewed',
  '--structural',
  example.path,
  '--atlas',
  'yeo7',
  '--threads',
  '4',
]);
const bridged = decodeVolume(await readFile(join(native, 'reviewed-lesion-atlas.nii')));
assert.deepEqual(bridged.dims, index.shape.slice(1));
assert.ok(bridged.data.some((value) => value > 0));
console.log(
  'PASS reviewed native candidate follows the complete PCA/SynthMorph atlas bridge offline'
);

const browserBridge = decodeVolume(
  await readFile(join(browserOutput, 'reviewed-lesion-atlas.nii'))
);
assert.deepEqual(bridged.dims, browserBridge.dims);
const bridgeDice = dice(bridged.data, browserBridge.data);
assert.ok(bridgeDice >= 0.995, `Reviewed atlas-mask browser Dice ${bridgeDice} < 0.995`);
console.log(`PASS complete reviewed-mask browser registration/atlas bridge Dice ${bridgeDice}`);
