#!/usr/bin/env node
// Downloads and checks the data an app's hardware-GPU tests need, then prints
// the environment that enables them as KEY=VALUE lines. CI appends the output
// to $GITHUB_ENV; locally, export the lines before `pnpm --filter <app> test:e2e`.
//
//   node scripts/gpu-test-data.mjs <app> [cache-directory]
//
// Every file is pinned: examples by the offline asset lock, models and
// SynthSeg goldens by their manifests. SynthSR's full-volume reference is the
// native CLI's CPU output on the pinned T1 example, built from exes/synthsr.
import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchPinnedExample } from './desktop/scientific-evidence.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const [app, cacheArgument] = process.argv.slice(2);
const cache = resolve(cacheArgument ?? join(process.env.TMPDIR ?? root, 'neurodesk-gpu-test-data'));

// Progress goes to stderr so stdout stays a clean KEY=VALUE list.
const run = (command, args) => execFileSync(command, args, { cwd: root, stdio: ['ignore', process.stderr, 'inherit'] });
const exampleFile = async (...args) => (await fetchPinnedExample(...args, cache)).map(({ path }) => path);

async function synthsrModel() {
  run('python3', ['exes/synthsr/scripts/fetch_model.py']);
  return join(root, 'exes/synthsr/models');
}

const provision = {
  brain2print: async () => ({}),
  dwi2trx: async () => {
    await exampleFile('dwi2trx', 'dwi-gradients', ['image', 'bval', 'bvec']);
    return { DWI2TRX_FIXTURE_DIR: join(cache, 'dwi2trx') };
  },
  syncro: async () => {
    const [image] = await exampleFile('syncro', 'trace-t1', ['primary']);
    return {
      SYNCRO_SCIENTIFIC_TESTS: '1',
      SYNCRO_AUTOMATION_IMAGE: image,
      SYNTHSR_MODEL: join(await synthsrModel(), 'synthsr-v2.onnx'),
    };
  },
  synthseg: async () => {
    const references = join(cache, 'synthseg');
    await mkdir(references, { recursive: true });
    run('make', ['-C', 'exes/synthseg', 'check-model', 'fetch-validation', `SYNTHSEG_REFERENCE_DIR=${references}`]);
    return {
      SYNTHSEG_E2E_FIXTURE: '1',
      SYNTHSEG_ASSET_DIR: join(root, 'exes/synthseg/models'),
      SYNTHSEG_REFERENCE_DIR: references,
    };
  },
  synthsr: async () => {
    const models = await synthsrModel();
    const [input] = await exampleFile('synthsr', 't1-head', ['image']);
    const reference = join(cache, 'synthsr', 'T1_head-native-cpu.nii.gz');
    run('make', ['-C', 'exes/synthsr', 'build']);
    run(join(root, 'exes/synthsr/target/release/synthsr'), [input, reference, '--device', 'cpu', '--force', '--quiet']);
    return { SYNTHSR_ASSET_DIR: models, SYNTHSR_FULL_INPUT: input, SYNTHSR_FULL_REFERENCE: reference };
  },
};

if (!provision[app]) {
  console.error(`Usage: gpu-test-data.mjs <${Object.keys(provision).join('|')}> [cache-directory]`);
  process.exit(2);
}
for (const [key, value] of Object.entries(await provision[app]())) console.log(`${key}=${value}`);
