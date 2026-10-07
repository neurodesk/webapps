import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { inflateNifti } from '@neurodesk/registration';
import { REGISTRATION_WASM_SHA256, loadRegistration } from '@neurodesk/registration/node';
import { artifactFiles } from './outputs.js';

export const ENGINE = 'ANTs 2.6.2 WebAssembly (@neurodesk/registration), ANTsPy 0.6.1 SyN schedule, seed 42, one thread';

export async function checkInstallation() {
  const ants = await loadRegistration();
  return {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    executable: process.execPath,
    engine: ENGINE,
    registrationWasmSha256: REGISTRATION_WASM_SHA256,
    heapBytes: ants.memoryBytes(),
  };
}

async function assertNewOutput(directory) {
  let entries;
  try {
    entries = await readdir(directory);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  if (entries.length) throw new Error(`Output directory ${directory} is not empty. Choose a new or empty directory.`);
}

// NIfTI-1 and NIfTI-2 begin with their header size, 348 or 540, in the file's byte order.
function isNifti(bytes) {
  if (bytes.length < 348) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, 4);
  return [348, 540].some((size) => view.getInt32(0, true) === size || view.getInt32(0, false) === size);
}

async function readNifti(path, role) {
  const bytes = await inflateNifti(await readFile(path));
  if (!isNifti(bytes)) throw new Error(`The ${role} image ${path} is not NIfTI. Convert DICOM with dcm2niix first.`);
  return bytes;
}

// The ITK-Wasm kernel prints through console.log and console.error and ignores a print override,
// so its log is captured here; otherwise it would mix with the file paths on standard output.
function capturingLog(onLog, run) {
  const { log, error } = console;
  console.log = onLog;
  console.error = onLog;
  try {
    return run();
  } finally {
    console.log = log;
    console.error = error;
  }
}

export async function registerImages({ moving, fixed, output, onLog = () => {} }) {
  if (!moving || !fixed || !output) throw new Error('A moving image, a fixed image and an output directory are required.');
  const destination = resolve(output);
  await assertNewOutput(destination);
  const [movingBytes, fixedBytes] = await Promise.all([readNifti(moving, 'moving'), readNifti(fixed, 'fixed')]);
  const ants = await loadRegistration();
  const started = performance.now();
  const result = capturingLog(onLog, () => ants.register({ fixed: fixedBytes, moving: movingBytes }));
  const seconds = (performance.now() - started) / 1000;
  const files = artifactFiles(basename(moving), result);
  await mkdir(destination, { recursive: true });
  for (const file of files) await writeFile(join(destination, file.name), file.bytes);
  return { output: destination, files: files.map((file) => file.name), seconds, heapBytes: ants.memoryBytes() };
}
