// Builds the fastprep core and glm as single-threaded wasm-bindgen packages into ./wasm (gitignored).
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
for (const [crate, out] of [['exes/fastprep/wasm', 'fastprep'], ['exes/glm/wasm', 'glm']]) {
  execFileSync('wasm-pack', ['build', `${root}${crate}`, '--release', '--target', 'web', '--no-pack',
    '--out-dir', fileURLToPath(new URL(`../wasm/${out}`, import.meta.url))], { stdio: 'inherit' });
}
