// Head-motion correction of one DWI series, for the web app and the command line alike: each
// volume is registered to the target the caller gives for it, in a pool of ANTs WebAssembly
// kernels, then resampled once with its own transform, and the BIDS-derivative outputs are
// written. The hosts inject their runtimes (`spawn`, `gzip`), as packages/brain2print does, so
// both write the same files. This module has no estimator loop: the caller decides the target
// of each volume (a b0 template, a model prediction) and the registration argv.
import { createNiftiFromData, decodeNiftiBuffer, extractNiftiHeader, readNiftiFrames } from "@neurodesk/webapp-components/file-io/nifti";
import { INTERPOLATION, derivativeSidecar, outputNames, sidecarText } from "./outputs.js";
import { createRegistrationPool } from "./pool.js";
import { IDENTITY } from "./wasm.js";

export { cancelled, createRegistrationPool } from "./pool.js";
export { INTERPOLATION, derivativeSidecar, outputNames, splitName } from "./outputs.js";
export { IDENTITY, METHODS, loadHmc } from "./wasm.js";

/** The transform file of a registration whose argv has `--output [out]`. */
export const TRANSFORM_FILE = "out0GenericAffine.mat";

/** The registration inputs, by the names the argv must use. */
export const INPUT_NAMES = Object.freeze({ fixed: "fixed.nii", moving: "moving.nii", mask: "mask.nii" });

/** The motion TSV columns of each method: NiFreeze is rigid, SHORELine affine. */
const COLUMNS = Object.freeze({ nifreeze: "rigid", shoreline: "affine" });

/**
 * Reads a 4D NIfTI (gzipped or not) into the series form correctHeadMotion takes.
 * @returns {Promise<{ data: Float32Array, dims: number[], frames: number, affine: number[][], headerBytes: ArrayBuffer }>}
 */
export async function readSeries(bytes) {
  const buffer = await decodeNiftiBuffer(bytes);
  const { data, header, dims, frames } = readNiftiFrames(buffer);
  return { data, dims, frames, affine: header.affine.map((row) => Array.from(row)), headerBytes: extractNiftiHeader(buffer), floating: [16, 64].includes(header.datatype) || header.sclSlope !== 1 || header.sclInter !== 0 };
}

/**
 * Corrects head motion in one series.
 *
 * @param {object} options
 * @param {{ data: Float32Array, dims: number[], frames: number, affine: number[][], headerBytes: ArrayBuffer }} options.series
 *   volume-major voxels (`data[volume * voxels + voxel]`), as readSeries returns
 * @param {number[]} options.bvals one b-value per volume
 * @param {number[][]} options.bvecs three rows (x, y, z) of one value per volume
 * @param {'nifreeze'|'shoreline'} options.method the b0, b-vector and motion-column rules
 * @param {(volume: number, b0: boolean) => Float32Array | (() => Float32Array | Float64Array) | null} options.target the fixed image of a
 *   volume on the series grid, a lazy target prepared when a worker is free, or null to keep it unchanged
 * @param {(volume: number, data: Float32Array) => Float32Array} [options.moving] prepare the registration sample
 * @param {number[]} [options.order] a permutation of all input frame indices
 * @param {(volume: number) => string[]} options.argv the antsRegistration argv of a volume; it reads
 *   INPUT_NAMES and writes `transformFile`
 * @param {Uint8Array | null} [options.mask] one byte per voxel, written as INPUT_NAMES.mask
 * @param {string} [options.transformFile] the output of each registration
 * @param {string} options.fileName the input file name, for the output names
 * @param {object | null} [options.sidecar] the input's JSON sidecar
 * @param {string} [options.interpolation] the --apply interpolator (default BSpline, order 3)
 * @param {object} options.hmc the API of loadHmc
 * @param {{ spawn: () => object, workers: number, gzip: (bytes: Uint8Array) => Promise<Uint8Array> | Uint8Array, kernel?: object }} options.runtime
 * @param {AbortSignal} [options.signal]
 * @param {(event: { stage: 'register'|'resample'|'write', volume?: number, done: number, total: number }) => void} [options.onProgress]
 * @returns {Promise<{ files: Record<string, Uint8Array>, names: object, transforms: object[], motion: object[], b0: boolean[], registered: boolean[] }>}
 */
export async function correctHeadMotion({
  series,
  bvals,
  bvecs,
  method = "nifreeze",
  target,
  moving,
  order,
  argv,
  mask = null,
  transformFile = TRANSFORM_FILE,
  fileName,
  sidecar = null,
  interpolation = INTERPOLATION,
  hmc,
  runtime,
  signal,
  onProgress,
}) {
  signal?.throwIfAborted();
  const { data, dims, frames, affine, headerBytes } = series;
  const voxels = dims[0] * dims[1] * dims[2];
  if (data.length !== voxels * frames) throw new Error("The series data does not fill its dimensions.");
  if (bvals.length !== frames) throw new Error(`The image has ${frames} volumes but the bval file lists ${bvals.length}.`);
  if (mask && mask.length !== voxels) throw new Error("The mask is not on the image grid.");
  if (!Object.hasOwn(COLUMNS, method)) throw new Error(`Unknown head-motion method ${JSON.stringify(method)}: use nifreeze or shoreline.`);

  const b0 = hmc.b0Flags(method, bvals, bvecs);
  const volume = (v) => data.subarray(v * voxels, (v + 1) * voxels);
  const nifti3d = (values) => new Uint8Array(createNiftiFromData(values instanceof Float32Array ? values : Float32Array.from(values), headerBytes, { dims: dims.slice(0, 3) }));
  const targets = Array.from({ length: frames }, (_, v) => target(v, b0[v]));
  targets.forEach((image, v) => {
    if (image && typeof image !== "function" && image.length !== voxels) throw new Error(`The target of volume ${v} is not on the image grid.`);
  });
  const visitOrder = order ?? Array.from({ length: frames }, (_, v) => v);
  if (visitOrder.length !== frames || new Set(visitOrder).size !== frames || visitOrder.some(v => !Number.isInteger(v) || v < 0 || v >= frames)) {
    throw new Error("The visit order must contain every input volume once.");
  }
  const registered = targets.map((image) => image !== null && image !== undefined);
  const total = registered.filter(Boolean).length;
  const corrected = new Float32Array(data.length);
  const matFiles = new Array(frames);
  const transforms = new Array(frames);
  let registeredCount = 0;
  let resampledCount = 0;

  const pool = createRegistrationPool({ spawn: runtime.spawn, workers: runtime.workers, signal, kernel: runtime.kernel });
  try {
    const work = [];
    for (const v of visitOrder) {
      if (!registered[v]) {
        corrected.set(volume(v), v * voxels);
        transforms[v] = IDENTITY;
        matFiles[v] = hmc.writeMat(IDENTITY);
        continue;
      }
      const inputs = () => {
        const fixed = typeof targets[v] === "function" ? targets[v]() : targets[v];
        if (fixed.length !== voxels) throw new Error(`The target of volume ${v} is not on the image grid.`);
        return {
          [INPUT_NAMES.fixed]: nifti3d(fixed),
          [INPUT_NAMES.moving]: nifti3d(moving ? moving(v, volume(v)) : volume(v)),
          ...(mask ? { [INPUT_NAMES.mask]: new Uint8Array(createNiftiFromData(Uint8Array.from(mask, (m) => (m ? 1 : 0)), headerBytes, { dims: dims.slice(0, 3) })) } : {}),
        };
      };
      work.push(
        pool
          .run({ argv: argv(v), inputs, transfer: true })
          .then(({ outputs }) => {
            const bytes = outputs[transformFile];
            if (!bytes) throw new Error(`The registration of volume ${v} wrote no ${transformFile}.`);
            matFiles[v] = bytes;
            transforms[v] = hmc.readMat(bytes);
            onProgress?.({ stage: "register", volume: v, done: ++registeredCount, total });
            // The one resampling of this volume, in the same pool.
            return pool.run({
              argv: ["--apply", "volume.nii", "volume.nii", "resampled.nii", interpolation, "0", "transform.mat"],
              inputs: () => ({ "volume.nii": nifti3d(volume(v)), "transform.mat": bytes.slice() }),
              transfer: true,
            });
          })
          .then(({ outputs }) => {
            const out = outputs["resampled.nii"];
            if (!out) throw new Error(`The resampling of volume ${v} wrote no image.`);
            const { data: values } = readNiftiFrames(out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength));
            if (values.length !== voxels) throw new Error(`The resampling of volume ${v} is not on the image grid.`);
            corrected.set(values, v * voxels);
            onProgress?.({ stage: "resample", volume: v, done: ++resampledCount, total });
          }),
      );
    }
    await Promise.all(work);
  } finally {
    await pool.close();
  }
  signal?.throwIfAborted();

  onProgress?.({ stage: "write", done: 0, total: 1 });
  signal?.throwIfAborted();
  const names = outputNames(fileName);
  const grid = { shape: dims.slice(0, 3), affine };
  const motion = hmc.motionParams(transforms, grid);
  const gradients = hmc.rotateGradients(method, bvals, bvecs, transforms, affine);
  const encoder = new TextEncoder();
  const image = new Uint8Array(createNiftiFromData(corrected, headerBytes, { dims: [...dims.slice(0, 3), frames] }));
  const compressed = await runtime.gzip(image);
  signal?.throwIfAborted();
  const files = {
    [names.image]: new Uint8Array(compressed),
    [names.bval]: encoder.encode(gradients.bval),
    [names.bvec]: encoder.encode(gradients.bvec),
    [names.motion]: encoder.encode(hmc.motionTsv(transforms, grid, { columns: COLUMNS[method] })),
    [names.sidecar]: encoder.encode(sidecarText(derivativeSidecar(sidecar, { method, interpolation, registered: total, volumes: frames }))),
  };
  for (let v = 0; v < frames; v++) files[names.transform(v)] = matFiles[v];
  onProgress?.({ stage: "write", done: 1, total: 1 });
  return { files, names, transforms, motion, b0, registered };
}
