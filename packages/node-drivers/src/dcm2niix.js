// Run the caller's pinned raw Emscripten build without browser globals.
export async function convertDicom(files, factory, { onLog = () => {} } = {}) {
  const module = await factory({ noInitialRun: true, print: onLog, printErr: onLog });
  module.FS.mkdir('/input');
  module.FS.mkdir('/output');
  for (let index = 0; index < files.length; index += 1) {
    module.FS.writeFile(`/input/${index}_${files[index].name.replaceAll('/', '_')}`, files[index].bytes);
  }
  const hostExitCode = process.exitCode;
  let status;
  try {
    status = module.callMain(['-o', '/output', '/input']);
  } catch (error) {
    if (typeof error?.status !== 'number') throw error;
    status = error.status;
  } finally {
    process.exitCode = hostExitCode;
  }
  if (status !== 0 && status !== 3) throw new Error(`dcm2niix processing failed with exit code ${status}`);
  return module.FS.readdir('/output').filter(name => /\.nii(\.gz)?$/i.test(name)).map(name => ({ name, bytes: module.FS.readFile(`/output/${name}`).slice() }));
}
