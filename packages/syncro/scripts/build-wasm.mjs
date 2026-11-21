// Builds the SYNcro Rust core (exes/syncro/wasm) as a wasm-bindgen package into ./wasm (gitignored).
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
execFileSync('wasm-pack', ['build', `${root}exes/syncro/wasm`, '--release', '--target', 'web', '--no-pack',
  '--out-dir', fileURLToPath(new URL('../wasm', import.meta.url))], { stdio: 'inherit' });
