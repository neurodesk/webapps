import { readFile } from 'node:fs/promises';

// Run the caller's pinned raw Emscripten build (`glue`: URL of e.g. dcm2niix.jpeg.js) without
// browser globals. The web build fetches its WASM, so Node hands over the file beside the glue.
export async function convertDicom(files, glue, { onLog = () => {} } = {}) {
  const { default: factory } = await import(glue);
  const wasmBinary = await readFile(new URL(String(glue).replace(/\.js$/, '.wasm')));
  const module = await factory({ noInitialRun: true, wasmBinary, print: onLog, printErr: onLog });
  module.FS.mkdir('/input');
  module.FS.mkdir('/output');
  for (let index = 0; index < files.length; index += 1) {
    module.FS.writeFile(`/input/${index}_${files[index].name.replaceAll('/', '_')}`, files[index].bytes);
  }
  const hostExitCode = process.exitCode;
  let status;
  try {
    status = module.callMain(['-f', '%p_%t_%s', '-o', '/output', '/input']);
  } catch (error) {
    if (typeof error?.status !== 'number') throw error;
    status = error.status;
  } finally {
    process.exitCode = hostExitCode;
  }
  if (status !== 0 && status !== 3) throw new Error(`dcm2niix processing failed with exit code ${status}`);
  return module.FS.readdir('/output').filter(name => /\.nii(\.gz)?$/i.test(name)).map(name => ({ name, bytes: module.FS.readFile(`/output/${name}`).slice() }));
}
