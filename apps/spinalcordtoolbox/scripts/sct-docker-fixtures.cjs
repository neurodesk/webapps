'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const fixtures = require('./batch-parity-fixtures.cjs');

const DEFAULT_SCT_IMAGE = 'vnmd/spinalcordtoolbox_7.1:20260428';
// lesion_ms needs SCT >= 7.2; this is the image pinned in registry/neurocontainers.json.
const LESION_MS_SCT_IMAGE = 'vnmd/spinalcordtoolbox_7.3.3:20260902';
const LESION_MS_FIXTURE_ID = 'course_t2_ms_deepseg_lesion_ms';

const DOCKER_FIXTURE_MAP = Object.freeze([
  {
    id: 'batch_t2_deepseg_spinalcord',
    input: 't2/t2.nii.gz',
    output: 't2/t2_seg.nii.gz'
  },
  {
    id: 'batch_t2s_deepseg_spinalcord',
    input: 't2s/t2s.nii.gz',
    output: 't2s/t2s_seg.nii.gz'
  },
  {
    id: 'batch_t2s_deepseg_graymatter',
    input: 't2s/t2s.nii.gz',
    output: 't2s/t2s_gmseg.nii.gz'
  },
  {
    id: 'batch_t1_deepseg_spinalcord_t1',
    input: 't1/t1.nii.gz',
    output: 't1/t1_seg.nii.gz'
  },
  {
    id: 'batch_t1_deepseg_spinalcord_t2',
    input: 't1/t2.nii.gz',
    output: 't1/t2_seg.nii.gz'
  },
  {
    id: 'batch_mt_deepseg_spinalcord',
    input: 'mt/mt1_crop.nii.gz',
    output: 'mt/mt1_crop_seg.nii.gz'
  },
  {
    id: 'batch_dmri_deepseg_spinalcord',
    input: 'dmri/dmri_moco_dwi_mean.nii.gz',
    output: 'dmri/dmri_moco_dwi_mean_seg.nii.gz'
  }
]);

function missingSctFixturePaths(rootDir) {
  const required = [path.join(rootDir, 'test_data/batch_processing.sh')];
  for (const fixture of fixtures.FIXTURE_CASES) {
    // The lesion_ms reference has its own generator below (different image and input).
    if (fixture.id === LESION_MS_FIXTURE_ID) continue;
    required.push(path.join(rootDir, fixture.inputPath));
    required.push(path.join(rootDir, fixture.expectedOutputPath));
  }
  return required.filter(filePath => !fs.existsSync(filePath));
}

// Regenerates the lesion_ms SCT reference from an input already in test_data
// (`node scripts/huggingface-fixtures.cjs` fetches it). `-single-fold` is the
// configuration the browser ships: fold 1 of the five-fold ensemble.
function generateLesionMsReference(rootDir) {
  const fixture = fixtures.FIXTURE_CASES.find(item => item.id === LESION_MS_FIXTURE_ID);
  if (!fixture) throw new Error(`Fixture ${LESION_MS_FIXTURE_ID} is not declared`);
  const fixtureDir = path.dirname(path.join(rootDir, fixture.inputPath));
  if (!fs.existsSync(path.join(rootDir, fixture.inputPath))) {
    throw new Error(`Missing ${fixture.inputPath}; run node scripts/huggingface-fixtures.cjs first`);
  }
  const docker = process.env.DOCKER || 'docker';
  const image = process.env.SCT_LESION_MS_DOCKER_IMAGE || LESION_MS_SCT_IMAGE;
  run(docker, [
    'run',
    '--rm',
    '--platform',
    'linux/amd64',
    '-v',
    `${fixtureDir}:/outputs`,
    image,
    'bash',
    '-lc',
    `sct_deepseg lesion_ms -i /outputs/input.nii.gz -single-fold -o /outputs/${path.basename(fixture.expectedOutputPath)} && chmod -R a+rwX /outputs`
  ], { cwd: rootDir, stdio: 'inherit' });
  return { generated: true, image };
}

function hasSctBatchFixtures(rootDir) {
  return missingSctFixturePaths(rootDir).length === 0;
}

function ensureSctBatchFixtures(rootDir, options = {}) {
  const force = options.force || process.env.SCT_BATCH_REGENERATE === '1';
  if (!force && hasSctBatchFixtures(rootDir)) return { generated: false };

  const docker = process.env.DOCKER || 'docker';
  const image = process.env.SCT_DOCKER_IMAGE || DEFAULT_SCT_IMAGE;
  const testDataDir = path.join(rootDir, 'test_data');
  fs.mkdirSync(testDataDir, { recursive: true });

  run(docker, ['pull', image], { cwd: rootDir, stdio: 'inherit' });
  run(docker, [
    'run',
    '--rm',
    '-v',
    `${testDataDir}:/outputs`,
    image,
    'bash',
    '-lc',
    dockerBatchCommand()
  ], { cwd: rootDir, stdio: 'inherit' });

  const missing = missingSctFixturePaths(rootDir);
  if (missing.length) {
    throw new Error(`SCT Docker fixture generation did not produce required files:\n${missing.map(filePath => `- ${path.relative(rootDir, filePath)}`).join('\n')}`);
  }
  return { generated: true, image };
}

function run(command, args, options) {
  const result = spawnSync(command, args, options);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const rendered = [command, ...args].join(' ');
    throw new Error(`${rendered} failed with exit code ${result.status}`);
  }
}

function dockerBatchCommand() {
  const copyCommands = DOCKER_FIXTURE_MAP.map(item => `
mkdir -p "/outputs/${item.id}"
cp "$SCT_DIR/data/sct_example_data/${item.input}" "/outputs/${item.id}/input.nii.gz"
cp "$SCT_DIR/data/sct_example_data/${item.output}" "/outputs/${item.id}/batch_output.nii.gz"`).join('\n');

  return `
set -euo pipefail
script="$(find "$SCT_DIR" -name batch_processing.sh -type f | head -n 1)"
if [ -z "$script" ]; then
  echo "batch_processing.sh was not found under SCT_DIR=$SCT_DIR" >&2
  exit 1
fi
cp "$script" /outputs/batch_processing.sh
SCT_BP_QC_FOLDER=/tmp/sct-batch-qc SCT_BP_NO_REMOVE_QC=1 bash "$script"
${copyCommands}
chmod -R a+rwX /outputs
`;
}

module.exports = {
  DEFAULT_SCT_IMAGE,
  DOCKER_FIXTURE_MAP,
  LESION_MS_SCT_IMAGE,
  dockerBatchCommand,
  ensureSctBatchFixtures,
  generateLesionMsReference,
  hasSctBatchFixtures,
  missingSctFixturePaths
};

if (require.main === module && process.argv.includes('--lesion-ms')) {
  const result = generateLesionMsReference(path.resolve(__dirname, '..'));
  console.log(`Generated the lesion_ms SCT reference with ${result.image}`);
}
