import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { parseBvalBvec } from "@neurodesk/dwi2trx/gradients";
import { loadMindgrabCpu } from "@neurodesk/node-drivers/mindgrab";
import { createNiftiFromData, createNiftiHeaderFromVolume, decodeNiftiBuffer, readNiftiFrames } from "@neurodesk/webapp-components/file-io/nifti";
import { readBrainMask } from "@neurodesk/webapp-components/file-io/brain-mask";
import { meanVolumes } from "@neurodesk/webapp-components/volume/mean";
import { readSeries, IDENTITY } from "./pipeline.js";
import { correctNiFreeze } from "./nifreeze.js";
import { loadHmcNode, nodeRuntime } from "./node-runtime.js";
import { loadHmcRegistration } from "@neurodesk/hmc-registration/node";

async function assertEmpty(directory) {
  try {
    if ((await readdir(directory)).length) throw new Error("Output directory must be new or empty.");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function defaultMask(series, buffer, bvals, bvecs, hmc, signal) {
  const voxels = series.dims.reduce((a, b) => a * b, 1);
  const volumes = hmc.b0Flags("nifreeze", bvals, bvecs).flatMap((b0, v) => b0 ? [v] : []);
  if (!volumes.length) throw new Error("The gradient table has no b0 volume for the default brain mask.");
  const mean = meanVolumes(series.data, voxels, volumes);
  signal?.throwIfAborted();
  const runtime = await loadMindgrabCpu(import.meta.resolve("@brainchop/mindgrab/package.json"));
  const result = await runtime.segment(new Uint8Array(createNiftiFromData(mean, buffer, { dims: series.dims })), {
    model: "mindgrab", mask: true, gzipOutput: false,
  });
  signal?.throwIfAborted();
  if (!result?.mask) throw new Error("MindGrab did not return a brain mask. Supply --mask FILE.");
  return { mask: await readBrainMask(result.mask, buffer, { grid: "DWI", signal }),
    provenance: { Source: "mindgrab", Model: "mindgrab", Version: runtime.version, Backend: result.backend } };
}

/** Reads files, runs the shared estimator and writes its BIDS derivatives without overwriting. */
export async function correctFiles({ dwi, bval, bvec, output, maskFile, sidecarFile, method = "gp", seed = 1234, workers = 1, signal, onProgress } = {}) {
  if (!dwi || !bval || !bvec || !output) throw new Error("A DWI, bval, bvec and output directory are required.");
  if (!["gp", "trivial"].includes(method)) throw new Error("--method must be gp or trivial.");
  if (!Number.isInteger(seed) || seed < 1 || seed > 2147483647) throw new Error("--seed must be an integer from 1 to 2147483647.");
  if (!Number.isSafeInteger(workers) || workers < 1) throw new Error("--workers must be a positive integer.");
  signal?.throwIfAborted();
  const destination = resolve(output);
  await assertEmpty(destination);
  const buffer = await decodeNiftiBuffer(new Uint8Array(await readFile(dwi)));
  const series = await readSeries(buffer);
  const { bvals, bvecs } = parseBvalBvec(await readFile(bval, "utf8"), await readFile(bvec, "utf8"));
  if (bvals.length !== series.frames) throw new Error(`The image has ${series.frames} volumes but the gradients list ${bvals.length}.`);
  const sidecar = sidecarFile ? JSON.parse(await readFile(sidecarFile, "utf8")) : null;
  if (sidecarFile && (!sidecar || typeof sidecar !== "object" || Array.isArray(sidecar))) throw new Error("The sidecar must be a JSON object.");
  const hmc = await loadHmcNode();
  const brain = maskFile
    ? { mask: await readBrainMask(new Uint8Array(await readFile(maskFile)), buffer, { name: basename(maskFile), grid: "DWI", signal }), provenance: { Source: "supplied" } }
    : await defaultMask(series, buffer, bvals, bvecs, hmc, signal);
  const { mask } = brain;
  if (!mask.some(Boolean)) throw new Error("The brain mask is empty.");
  const result = await correctNiFreeze({
    series, bvals, bvecs, mask, maskProvenance: brain.provenance, model: method, seed, sidecar,
    fileName: basename(dwi), hmc, runtime: nodeRuntime({ workers }), signal, onProgress,
  });
  signal?.throwIfAborted();
  await mkdir(destination, { recursive: true });
  for (const [name, bytes] of Object.entries(result.files)) {
    signal?.throwIfAborted();
    await writeFile(join(destination, name), bytes, { flag: "wx" });
  }
  signal?.throwIfAborted();
  return { ...result, output: destination };
}

/** Initializes the bundled CPU mask runtime; its models are compiled into the pinned package. */
export async function prepareModels() {
  await loadMindgrabCpu(import.meta.resolve("@brainchop/mindgrab/package.json"));
}

/** Executes the pinned registration kernel's resampler on an identity phantom. */
export async function checkInstallation() {
  const dims = [8, 8, 8];
  const data = Float32Array.from({ length: 512 }, (_, i) => i);
  const header = createNiftiHeaderFromVolume({ hdr: { dims: [3, ...dims, 1, 1, 1, 1], pixDims: [1, 2, 2, 2, 1, 1, 1, 1] } });
  const image = new Uint8Array(createNiftiFromData(data, header, { dims }));
  const hmc = await loadHmcNode();
  const kernel = await loadHmcRegistration();
  const { outputs } = kernel.run(["--apply", "input.nii", "input.nii", "output.nii", "Linear", "0", "identity.mat"], {
    "input.nii": image, "identity.mat": hmc.writeMat(IDENTITY),
  });
  const result = readNiftiFrames(await decodeNiftiBuffer(outputs["output.nii"]));
  if (!result.data.every((value, i) => value === data[i])) throw new Error("HMC identity resampling check failed.");
  return { executable: process.execPath, node: process.version, platform: process.platform, arch: process.arch,
    phantom: "512 identity-resampled voxels unchanged" };
}
