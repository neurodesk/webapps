// The n4 command line: the web app's correction (the same N4 WebAssembly module, the same mean b0,
// the same NIfTI writer and output names) on Node, with MindGrab's CPU modules for the brain mask.
import { randomUUID } from "node:crypto";
import { access, link, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { loadMindgrabCpu } from "@neurodesk/node-drivers/mindgrab";
import {
  createNiftiFromData,
  createNiftiHeaderFromVolume,
  decodeNiftiBuffer,
  isValidNifti1,
  readNiftiFrames,
  readNiftiImageData,
} from "@neurodesk/webapp-components/file-io/nifti";
import { sidecarText } from "@neurodesk/webapp-components/file-io/bids-derivatives";
import { binaryMask, readBrainMask } from "@neurodesk/webapp-components/file-io/brain-mask";
import { meanVolumes } from "@neurodesk/webapp-components/volume/mean";
import packageJson from "../package.json" with { type: "json" };
import createModule from "../wasm/n4-bias.mjs";
import { DEFAULTS, createN4, divideVolumes, rescaleBias } from "./index.js";
import { METHOD, b0Volumes, n4Sidecar, outputNames, parseBval } from "./pipeline.js";

const MINDGRAB_PACKAGE = import.meta.resolve("@brainchop/core/package.json");
export const MINDGRAB_VERSION = JSON.parse(await readFile(new URL(MINDGRAB_PACKAGE), "utf8")).version;

/** The web app's MindGrab call (runtime-support's brainMask), here on the CPU. */
export const MASK_OPTIONS = Object.freeze({ model: "mindgrab", mask: true, gzipOutput: false });

const exists = (path) => access(path).then(() => true, () => false);

// The stem the web app pairs gradient files and sidecars by (readDiffusionSeries).
const stem = (name) => name.replace(/\.(nii\.gz|[^.]*)$/i, "");

async function engine(onLog) {
  const wasmBinary = await readFile(new URL("../wasm/n4-bias.wasm", import.meta.url));
  return createN4({ createModule, wasmBinary, onLog: (line) => onLog?.(line) });
}

// FSL gradient files as readDiffusionSeries matches them: dwi.bval and dwi.bvec as dcm2niix
// writes them, dwi.bvals and dwi.bvecs, or FSL's bare bvals and bvecs.
const BVAL_FILE = /(^|\.)bvals?$/i;
const BVEC_FILE = /(^|\.)bvecs?$/i;
const NIFTI_FILE = /\.nii(\.gz)?$/i;

/**
 * The input's .bval, .bvec and .json: those given, else those beside it, paired as the web app
 * pairs a selection of the image and its directory (readDiffusionSeries). A gradient file pairs
 * by stem (`dwi.bval`, `dwi.bvals`); for a series (`volumes` > 1, or not known) a sole gradient
 * file that no other image in the directory owns pairs whatever its name, as FSL's `bvals` and
 * `bvecs` do. Several such files are refused rather than guessed. The sidecar pairs by stem only.
 */
export async function companions(input, { bval, bvec, json } = {}, { volumes } = {}) {
  const directory = dirname(input);
  const own = stem(basename(input));
  const entries = await readdir(directory).catch(() => []);
  const images = new Set(entries.filter((name) => NIFTI_FILE.test(name)).map(stem));
  const given = async (path) => {
    if (!await exists(path)) throw new Error(`${path} does not exist.`);
    return path;
  };
  const gradient = async (path, pattern, option) => {
    if (path !== undefined) return given(path);
    const found = entries.filter((name) => pattern.test(name));
    const same = found.find((name) => stem(name) === own);
    if (same) return join(directory, same);
    if (volumes === 1) return null;
    const unowned = found.filter((name) => !images.has(stem(name)));
    if (unowned.length > 1) throw new Error(`${directory} holds ${unowned.length} ${option} files (${unowned.join(", ")}) and none has the stem ${own}. Name one with --${option}.`);
    return unowned.length ? join(directory, unowned[0]) : null;
  };
  return {
    bval: await gradient(bval, BVAL_FILE, "bval"),
    bvec: await gradient(bvec, BVEC_FILE, "bvec"),
    json: json !== undefined ? await given(json) : (await exists(join(directory, `${own}.json`)) ? join(directory, `${own}.json`) : null),
  };
}

/**
 * The sidecar as the web app parses it: an object, or null when absent. A sidecar beside the
 * image that does not parse to an object is left out, as the app leaves it out; one named with
 * --json must parse to an object.
 */
async function readSidecar(path, named) {
  if (!path) return null;
  let value;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (named) throw new Error(`The sidecar ${path} is not valid JSON (${error.message}).`);
    return null;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (named) throw new Error(`The sidecar ${path} must hold a JSON object.`);
  return null;
}

async function assertNewOutput(directory) {
  let entries;
  try {
    entries = await readdir(directory);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (entries.length) throw new Error(`Output directory ${directory} is not empty. Choose a new or empty directory.`);
}

// Each file appears under its name complete, and never replaces one a concurrent run wrote there:
// link() fails when the name exists.
async function publish(path, bytes) {
  const partial = join(dirname(path), `.${randomUUID().slice(0, 8)}.partial`);
  try {
    await writeFile(partial, bytes, { flag: "wx" });
    await link(partial, path);
  } finally {
    await rm(partial, { force: true });
  }
}

async function readNifti(path, role) {
  const buffer = await decodeNiftiBuffer(new Uint8Array(await readFile(path)));
  if (!isValidNifti1(buffer)) throw new Error(`The ${role} ${path} is not NIfTI-1. Convert DICOM with dcm2niix first.`);
  return buffer;
}

/** Reads an image and its b-values as the web app does, and picks the volumes the field is fitted to. */
export async function readInput({ image, bval, buffer, frames }) {
  buffer ??= await readNifti(image, "image");
  frames ??= readNiftiFrames(buffer);
  const name = basename(image);
  const bvals = bval ? parseBval(await readFile(bval, "utf8"), frames.frames) : null;
  const reference = b0Volumes(bvals, frames.frames);
  const voxels = frames.dims[0] * frames.dims[1] * frames.dims[2];
  return { name, buffer, ...frames, voxels, bvals, reference };
}

/** A brain mask file on the image grid, as the web app's mask input reads it. */
async function readMask(path, input) {
  const buffer = await readNifti(path, "brain mask");
  return readBrainMask(buffer, input.buffer, { name: basename(path), grid: "image" });
}

/** MindGrab's brain mask of the reference (the mean b0, or the image), on MindGrab's CPU modules. */
async function mindgrabMask(referenceNifti) {
  const mindgrab = await loadMindgrabCpu(MINDGRAB_PACKAGE);
  let result;
  try {
    result = await mindgrab.segment(new Uint8Array(referenceNifti), MASK_OPTIONS);
  } catch (error) {
    throw new Error(`MindGrab could not mask the image (${error.message}). Give --mask FILE.`);
  }
  if (!result?.mask) throw new Error("MindGrab did not return a brain mask. Give --mask FILE.");
  return { mask: binaryMask(readNiftiFrames(result.mask).data), backend: result.backend, elapsedMs: Math.round(result.elapsedMs) };
}

/**
 * Corrects the bias field of `input` as the web app does and writes its downloads into the new or
 * empty directory `output`: the corrected image, the bias field, the brain mask, and the .bval,
 * .bvec and sidecar when the input has them. A 3D image is corrected by N4 directly; for a series
 * the field is fitted to the mean b0 (the mean of every volume without b-values), rescaled to keep
 * the brain integral and divided out of every volume, as MRtrix `dwibiascorrect ants` does. The
 * mask is MindGrab's of that reference unless `mask` names one on the image grid.
 */
export async function correct({ input, output, bval, bvec, json, mask: maskFile, onProgress = () => {}, onLog } = {}) {
  if (!input || !output) throw new Error("Give a NIfTI image and a new output directory.");
  if (!/\.nii(\.gz)?$/i.test(input)) throw new Error(`${input} is not a NIfTI image (.nii or .nii.gz). Convert DICOM with dcm2niix first.`);
  if (!await exists(input)) throw new Error(`${input} does not exist.`);
  if (maskFile !== undefined && !await exists(maskFile)) throw new Error(`${maskFile} does not exist.`);
  const destination = resolve(output);
  await assertNewOutput(destination);
  const buffer = await readNifti(input, "image");
  const frames = readNiftiFrames(buffer);
  const paired = await companions(input, { bval, bvec, json }, { volumes: frames.frames });
  const sidecar = await readSidecar(paired.json, json !== undefined);
  const image = await readInput({ image: input, bval: paired.bval, buffer, frames });
  const reference = meanVolumes(image.data, image.voxels, image.reference);
  const referenceNifti = createNiftiFromData(reference, image.buffer, { dims: image.dims });
  onProgress(`${image.name}: ${image.dims.join("×")}${image.frames > 1 ? `×${image.frames}` : ""}; the field is fitted to ${image.frames === 1 ? "the image" : `the mean of ${image.reference.length} ${image.bvals ? "b0 " : ""}volumes`}`);

  let brain;
  let mask;
  if (maskFile !== undefined) {
    brain = await readMask(maskFile, image);
    mask = "supplied";
  } else {
    onProgress(`Extracting the brain from ${image.frames > 1 ? "the mean b0" : "the image"} with MindGrab ${MINDGRAB_VERSION} (CPU)`);
    const extracted = await mindgrabMask(referenceNifti);
    brain = extracted.mask;
    mask = `mindgrab-${MINDGRAB_VERSION}-${extracted.backend}`;
    onProgress(`MindGrab brain mask in ${(extracted.elapsedMs / 1000).toFixed(0)} s`);
  }
  const maskVoxels = brain.reduce((sum, value) => sum + value, 0);
  if (!maskVoxels) throw new Error("The brain mask has no voxels. Supply a mask, or check the image.");

  onProgress(`Fitting the bias field to ${maskVoxels} voxels`);
  const started = performance.now();
  const n4 = await engine(onLog);
  const fitted = await n4.correct({ image: new Uint8Array(referenceNifti), weight: new Uint8Array(createNiftiFromData(brain, image.buffer, { dims: image.dims })) });
  const correctedReference = readNiftiImageData(fitted.corrected).data;
  let field = readNiftiImageData(fitted.bias).data;
  let corrected;
  let multiplier = null;
  if (image.frames > 1) {
    const scaled = rescaleBias(reference, correctedReference, brain, field);
    field = scaled.bias;
    multiplier = scaled.multiplier;
    onProgress(`Bias field rescaled by ${multiplier.toPrecision(6)}`);
    corrected = divideVolumes(image.data, image.voxels, image.frames, field);
  } else {
    corrected = correctedReference;
  }
  const seconds = Math.round((performance.now() - started) / 100) / 10;

  const names = outputNames(image.name);
  const dims = image.frames > 1 ? [...image.dims, image.frames] : image.dims;
  const nifti = (data, size) => gzipSync(new Uint8Array(createNiftiFromData(data, image.buffer, { dims: size })));
  const written = [
    { role: "image", name: names.image, bytes: nifti(Float32Array.from(corrected), dims) },
    { role: "bias", name: names.bias, bytes: nifti(Float32Array.from(field), image.dims) },
    { role: "mask", name: names.mask, bytes: nifti(brain, image.dims) },
  ];
  for (const role of ["bval", "bvec"]) {
    if (paired[role]) written.push({ role, name: names[role], bytes: await readFile(paired[role]) });
  }
  if (sidecar) written.push({ role: "sidecar", name: names.sidecar, bytes: Buffer.from(sidecarText(n4Sidecar(sidecar))) });
  await mkdir(destination, { recursive: true });
  for (const file of written) await publish(join(destination, file.name), file.bytes);
  return {
    output: destination,
    files: written.map(({ role, name }) => ({ role, name })),
    provenance: {
      app: `n4 command line ${packageJson.version}`,
      method: METHOD,
      procedure: image.frames > 1 ? "mrtrix-dwibiascorrect-ants" : "n4",
      mask,
      maskVoxels,
      shrink: DEFAULTS.shrink,
      bspline: DEFAULTS.bspline,
      convergence: DEFAULTS.convergence,
      referenceVolumes: image.reference.length,
      volumes: image.frames,
      multiplier,
      seconds,
    },
  };
}

// A 24 x 24 x 24 block of tissue in a zero background whose intensity a smooth ramp multiplies from
// 0.6 to 1.4 across x, as a receive coil would shade it, and the block as its mask.
function rampPhantom() {
  const n = 24;
  const voxels = n ** 3;
  const data = new Float32Array(voxels);
  const mask = new Uint8Array(voxels);
  for (let z = 4; z < n - 4; z++) {
    for (let y = 4; y < n - 4; y++) {
      for (let x = 4; x < n - 4; x++) {
        const i = x + n * (y + n * z);
        data[i] = 100 * (0.6 + (0.8 * x) / (n - 1));
        mask[i] = 1;
      }
    }
  }
  const header = createNiftiHeaderFromVolume({ hdr: { dims: [3, n, n, n, 1, 1, 1, 1], pixDims: [1, 4, 4, 4, 1, 1, 1, 1] } });
  return {
    data,
    mask,
    image: new Uint8Array(createNiftiFromData(data, header, { dims: [n, n, n] })),
    weight: new Uint8Array(createNiftiFromData(mask, header, { dims: [n, n, n] })),
  };
}

function variation(data, mask) {
  const values = Array.from(data).filter((_, i) => mask[i]);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length) / mean;
}

/**
 * Runs the N4 module on a ramp phantom inside this runtime: the correction must at least halve the
 * tissue's coefficient of variation. MindGrab's CPU modules must load and list the mindgrab model.
 */
export async function checkInstallation() {
  const phantom = rampPhantom();
  const n4 = await engine();
  const { corrected } = await n4.correct({ image: phantom.image, weight: phantom.weight });
  const before = variation(phantom.data, phantom.mask);
  const after = variation(readNiftiImageData(corrected).data, phantom.mask);
  if (!(after < before / 2)) throw new Error(`N4 failed its phantom check: the tissue's variation went from ${before.toFixed(4)} to ${after.toFixed(4)}, not below half.`);
  const mindgrab = await loadMindgrabCpu(MINDGRAB_PACKAGE);
  if (!mindgrab.MODELS?.mindgrab) throw new Error("The MindGrab package does not list the mindgrab model.");
  return {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    executable: process.execPath,
    n4: packageJson.version,
    mindgrab: MINDGRAB_VERSION,
    phantomVariation: { before: Number(before.toFixed(4)), after: Number(after.toFixed(4)) },
  };
}
