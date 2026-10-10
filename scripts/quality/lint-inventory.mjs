import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// Exclude committed compiler output and third-party distributions by exact path.
// Scientific ports and imported app sources still receive the correctness rules.
export const exclusions = {
  'apps/qsmbly/niivue/index.js': 'Bundled third-party NiiVue distribution.',
  'packages/runtime-support/src/dcm2niix/dcm2niix.js': 'Generated Emscripten glue.',
  'packages/runtime-support/src/niimath/niimath.js': 'Generated Emscripten glue.',
  'packages/runtime-support/src/nifti-js/index.js': 'Vendored third-party UMD distribution.',
  'apps/dicom2vid/web/js/vendor/mp4-muxer.js': 'Third-party muxer distribution.',
  'apps/dicom2vid/web/js/vendor/niivue.js': 'Third-party NiiVue distribution.',
  'apps/dicom2vid/web/js/vendor/webm-muxer.js': 'Third-party muxer distribution.',
  'apps/dwi2trx/vendor/niimath/dist/index.js': 'Vendored niimath build, upstream-owned.',
  'apps/dwi2trx/vendor/niimath/dist/niimath.js': 'Generated Emscripten glue.',
  'apps/dwi2trx/vendor/niimath/dist/types.js': 'Vendored niimath build, upstream-owned.',
  'apps/dwi2trx/vendor/niimath/dist/worker.js': 'Vendored niimath build, upstream-owned.',
  'packages/easy-mp2rage/wasm/mp2rage_wasm.js': 'Generated wasm-bindgen glue, rebuilt by WASM parity CI.',
  'packages/nii2tvx/wasm/nii2tvx.mjs': 'Generated Emscripten glue, rebuilt by make.',
  'packages/registration/wasm/syncro-registration.mjs': 'Generated Emscripten glue.',
  'packages/vesselboost/preprocessing/preprocessing.js': 'Generated wasm-bindgen glue.',
};

export function sourceInventory(cwd) {
  const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd, encoding: 'utf8' });
  return [...new Set(files.split('\0'))]
    .filter((file) => /\.(?:[cm]?js|jsx|[cm]?ts|tsx)$/.test(file))
    // Declarations have no executable behavior. Type checking owns them.
    .filter((file) => !/\.d\.[cm]?ts$/.test(file) && !Object.hasOwn(exclusions, file))
    .filter((file) => existsSync(join(cwd, file)))
    .sort();
}

export async function assertCoverage(eslint, files) {
  for (const file of files) {
    const config = await eslint.calculateConfigForFile(file);
    const required = ['no-unreachable', 'no-dupe-keys', 'no-constant-condition'];
    if (!/\.[cm]?tsx?$/.test(file)) required.push('no-undef');
    if (!config || required.some((rule) => config.rules?.[rule]?.[0] !== 2)) {
      throw new Error(`No effective correctness rules for ${file}`);
    }
  }
}
