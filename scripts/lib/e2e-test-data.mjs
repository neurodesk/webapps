// The data each app's browser suite needs to run its data-gated tests, and the
// environment that enables them. Every file is pinned: examples by the offline
// asset lock, models and goldens by their manifests. Apps whose tests need a
// hardware GPU (ci.hardware_gpu) are provisioned on the macOS runner; the rest
// on Linux. A hardware-GPU app's optional `cpu` provisioner is the subset of its
// tests that a CPU-only browser can finish; Linux runs that subset with `--cpu`.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchPinnedExample } from '../desktop/scientific-evidence.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

// Progress goes to stderr so callers can keep stdout for KEY=VALUE lines.
const run = (command, args) => execFileSync(command, args, { cwd: root, stdio: ['ignore', process.stderr, 'inherit'] });
const exampleFiles = async (cache, ...args) => (await fetchPinnedExample(...args, cache)).map(({ path }) => path);

// Downloads url to path unless a copy with this size and SHA-256 is already there.
async function fetchChecked(url, path, { bytes, sha256 }) {
  const matches = (data) => data.length === bytes && createHash('sha256').update(data).digest('hex') === sha256;
  if (matches(await readFile(path).catch(() => Buffer.alloc(0)))) return;
  console.error(`Downloading ${url}`);
  const response = await fetch(url, { signal: AbortSignal.timeout(1_200_000) });
  if (!response.ok) throw new Error(`${response.status}: ${url}`);
  const data = Buffer.from(await response.arrayBuffer());
  if (!matches(data)) throw new Error(`${url} does not match its pinned size and SHA-256`);
  await writeFile(`${path}.partial`, data);
  await rename(`${path}.partial`, path);
}

function synthsrModels() {
  run('python3', ['exes/synthsr/scripts/fetch_model.py']);
  return join(root, 'exes/synthsr/models');
}

// Apps that fetch their own pinned data once a flag is set.
const flag = (name) => ({ env: [name], provision: async () => ({ [name]: '1' }) });

export const provisioners = {
  // The browser reference registers the 1 mm example once, about 3 min on a 4-core runner.
  ants: { env: ['ANTS_LIVE_DATA', 'ANTS_BROWSER_REFERENCE'], provision: async () => ({ ANTS_LIVE_DATA: '1', ANTS_BROWSER_REFERENCE: 'check' }) },
  'brain-extraction': flag('BRAIN_EXTRACTION_REAL_MODELS'),
  // The browser reference runs quality control of the pinned example with each of the four models
  // on the CPU backend, about 12 min on eight cores.
  browserqc: { env: ['BROWSERQC_BROWSER_REFERENCE'], provision: async () => ({ BROWSERQC_BROWSER_REFERENCE: 'check' }) },
  brain2print: { env: [], provision: async () => ({}) },
  calmar: { env: ['CALMAR_AUTOMATION_IMAGE'], provision: async () => ({ CALMAR_AUTOMATION_IMAGE: 'example' }) },
  disconnectome: flag('DISCONNECTOME_LIVE_DATA'),
  dwi2trx: {
    env: ['DWI2TRX_FIXTURE_DIR'],
    provision: async (cache) => {
      await exampleFiles(cache, 'dwi2trx', 'dwi-gradients', ['image', 'bval', 'bvec']);
      return { DWI2TRX_FIXTURE_DIR: join(cache, 'dwi2trx') };
    },
  },
  // The browser reference registers the 1 mm example once, about 30 s.
  edgereg: { env: ['EDGEREG_BROWSER_REFERENCE'], provision: async () => ({ EDGEREG_BROWSER_REFERENCE: 'check' }) },
  // Both presets on the CPU, about 35 min each; the reference needs exactly 4 threads, which
  // matches GitHub's Linux runners.
  fireants: { env: ['FIREANTS_BROWSER_REFERENCE'], provision: async () => ({ FIREANTS_BROWSER_REFERENCE: 'check' }) },
  greedy: flag('GREEDY_LIVE_DATA'),
  // The browser reference fits all 14 cases of packages/lcmodel/validation/reference.mjs, about 5 min.
  lcmodel: { env: ['LCMODEL_E2E_LARGE', 'LCMODEL_BROWSER_REFERENCE'], provision: async () => ({ LCMODEL_E2E_LARGE: '1', LCMODEL_BROWSER_REFERENCE: 'check' }) },
  nesvor: {
    env: ['NESVOR_MASK_FIXTURE_DIR'],
    provision: async (cache) => {
      // The MONAIfbs export and three central slices of the first pinned fetal stack.
      const directory = join(cache, 'nesvor', 'monaifbs');
      await mkdir(directory, { recursive: true });
      const manifest = JSON.parse(await readFile(join(root, 'packages/nesvor/src/masking/manifest.json'), 'utf8'));
      await fetchChecked(manifest.base_url + manifest.file, join(directory, manifest.file), manifest);
      const [stack] = await exampleFiles(cache, 'nesvor', 'svrtk-simulated-fetal', ['stack']);
      run(process.execPath, ['packages/nesvor/src/masking/verify-stack.mjs', stack, directory, '--prepare']);
      return { NESVOR_MASK_FIXTURE_DIR: directory };
    },
  },
  syncro: {
    env: ['SYNCRO_SCIENTIFIC_TESTS', 'SYNCRO_AUTOMATION_IMAGE', 'SYNTHSR_MODEL'],
    provision: async (cache) => {
      const [image] = await exampleFiles(cache, 'syncro', 'trace-t1', ['primary']);
      return { SYNCRO_SCIENTIFIC_TESTS: '1', SYNCRO_AUTOMATION_IMAGE: image, SYNTHSR_MODEL: join(synthsrModels(), 'synthsr-v2.onnx') };
    },
    // The pinned T1 through WASM SynthSR, SynthStrip and Greedy needs no GPU (issue #211).
    cpu: {
      env: ['SYNCRO_AUTOMATION_IMAGE'],
      provision: async (cache) => {
        const [image] = await exampleFiles(cache, 'syncro', 'trace-t1', ['primary']);
        return { SYNCRO_AUTOMATION_IMAGE: image };
      },
    },
  },
  synthseg: {
    env: ['SYNTHSEG_E2E_FIXTURE', 'SYNTHSEG_ASSET_DIR', 'SYNTHSEG_REFERENCE_DIR'],
    provision: async (cache) => {
      const references = join(cache, 'synthseg');
      await mkdir(references, { recursive: true });
      run('make', ['-C', 'exes/synthseg', 'check-model', 'fetch-validation', `SYNTHSEG_REFERENCE_DIR=${references}`]);
      return { SYNTHSEG_E2E_FIXTURE: '1', SYNTHSEG_ASSET_DIR: join(root, 'exes/synthseg/models'), SYNTHSEG_REFERENCE_DIR: references };
    },
  },
  synthsr: {
    env: ['SYNTHSR_ASSET_DIR', 'SYNTHSR_FULL_INPUT', 'SYNTHSR_FULL_REFERENCE'],
    provision: async (cache) => {
      // The full-volume input behind the published validation was never released, so the
      // reference is the native CLI's CPU output on the pinned T1 example.
      const models = synthsrModels();
      const [input] = await exampleFiles(cache, 'synthsr', 't1-head', ['image']);
      const reference = join(cache, 'synthsr', 'T1_head-native-cpu.nii.gz');
      run('make', ['-C', 'exes/synthsr', 'build']);
      run(join(root, 'exes/synthsr/target/release/synthsr'), [input, reference, '--device', 'cpu', '--force', '--quiet']);
      return { SYNTHSR_ASSET_DIR: models, SYNTHSR_FULL_INPUT: input, SYNTHSR_FULL_REFERENCE: reference };
    },
  },
  topofit: {
    env: ['TOPOFIT_AUTOMATION_IMAGE'],
    provision: async (cache) => {
      const [image] = await exampleFiles(cache, 'topofit', 'openneuro-t1', ['image']);
      return { TOPOFIT_AUTOMATION_IMAGE: image };
    },
  },
};

// Gates no public data can open. Each needs a reason; the test suite rejects any
// other gate that no provisioner sets.
export const unpublished = {
  CAROTID_FLOW_EXAMPLE: "the requesting lab's export, not licensed for release",
  TOPOFIT_SURFACE_REPLAY: 'OpenRecon validation surfaces, not licensed for release',
};

// With `cpu`, only the app's CPU subset; for an app without one, nothing.
export async function provisionTestData(app, cache, { cpu = false } = {}) {
  const provisioner = cpu ? provisioners[app]?.cpu : provisioners[app];
  if (!provisioner) return {};
  const environment = await provisioner.provision(cache);
  const keys = Object.keys(environment).sort();
  if (keys.join() !== [...provisioner.env].sort().join()) {
    throw new Error(`${app}: provisioned ${keys.join(', ')} but declares ${provisioner.env.join(', ')}`);
  }
  return environment;
}
