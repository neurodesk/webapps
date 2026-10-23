// Copies the browser-free modules the web app imports into apps/mri2vid/web/vendor/mri2vid/,
// and the JPEG build of dcm2niix (worker, glue and WebAssembly) into web/vendor/dcm2niix/.
// The Node-only modules (the command line and its libvpx encoder) stay behind.
import { cp, mkdir, rm } from 'node:fs/promises';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const NODE_ONLY = new Set(['node.js', 'libav.js', 'encoder.js']);
const vendor = new URL('../../../apps/mri2vid/web/vendor/', import.meta.url);
const destination = new URL('mri2vid/src/', vendor);
await rm(destination, { recursive: true, force: true });
await cp(new URL('../src/', import.meta.url), destination, {
  recursive: true,
  filter: (path) => !NODE_ONLY.has(basename(path)),
});
console.log(`Staged the shared mri2vid modules: ${fileURLToPath(destination)}`);

const dcm2niix = new URL('dcm2niix/', vendor);
const dist = new URL('./', import.meta.resolve('@niivue/dcm2niix'));
await rm(dcm2niix, { recursive: true, force: true });
await mkdir(dcm2niix, { recursive: true });
for (const name of ['index.jpeg.js', 'worker.jpeg.js', 'dcm2niix.jpeg.js', 'dcm2niix.jpeg.wasm']) {
  await cp(new URL(name, dist), new URL(name, dcm2niix));
}
console.log(`Staged dcm2niix: ${fileURLToPath(dcm2niix)}`);
