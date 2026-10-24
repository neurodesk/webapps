// Host-neutral workload and verification. Loading and output verification sit outside the
// timed correctNiFreeze call; both hosts run exactly this code and the same pinned bytes.
import { decodeNiftiBuffer, readNiftiFrames, sameNiftiGrid } from "@neurodesk/webapp-components/file-io/nifti";
import { correctNiFreeze } from "../src/nifreeze.js";
import { readSeries } from "../src/pipeline.js";

const decoder = new TextDecoder();
const numbers = bytes => decoder.decode(bytes).trim().split(/\s+/).map(Number);
const hash = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");

export async function prepareBenchmark(config, { readBytes, loadHmc, runtime }) {
  const loadStart = performance.now();
  const series = await readSeries(await readBytes(config.files.image));
  const maskBytes = await decodeNiftiBuffer(await readBytes(config.files.mask));
  const mask = readNiftiFrames(maskBytes);
  if (mask.frames !== 1 || !sameNiftiGrid(series.headerBytes, maskBytes)) throw new Error("Benchmark mask is not one volume on the diffusion grid.");
  const bvals = numbers(await readBytes(config.files.bval));
  const bvecs = decoder.decode(await readBytes(config.files.bvec)).trim().split("\n").map(row => row.trim().split(/\s+/).map(Number));
  const hmc = await loadHmc();
  const input = { series, bvals, bvecs, mask: Uint8Array.from(mask.data, value => value ? 1 : 0), hmc, runtime, fileName: config.fileName, model: config.model, seed: config.seed };
  const b0 = hmc.b0Flags("nifreeze", bvals, bvecs);
  const expected = bvals.filter(value => value > 50).length;
  if (b0.some((flag, i) => flag !== (bvals[i] <= 50))) throw new Error("The benchmark b0 split does not match the NiFreeze threshold.");
  // Keep evidence independent of the mutable series passed into the measured pipeline.
  const voxels = series.dims.reduce((a, b) => a * b);
  const originalB0Hashes = new Map();
  for (let frame = 0; frame < series.frames; frame++) if (b0[frame]) {
    originalB0Hashes.set(frame, await hash(series.data.subarray(frame * voxels, (frame + 1) * voxels)));
  }
  const loaded = { loadSeconds: (performance.now() - loadStart) / 1000, frames: series.frames, voxels, rawFloat32Bytes: series.data.byteLength, expectedRegistrations: expected };
  let result;
  let measured;
  return {
    loaded,
    async run() {
      const completed = { register: 0, resample: 0, write: 0 };
      const start = performance.now();
      result = await correctNiFreeze({ ...input, onProgress: event => { completed[event.stage] = event.done; } });
      measured = { seconds: (performance.now() - start) / 1000, completed };
      if (completed.register !== expected || completed.resample !== expected || completed.write !== 1) throw new Error("The benchmark did not complete every registration, resampling and output write.");
      return measured;
    },
    async verify() {
      if (!result) throw new Error("The measured operation has not completed.");
      const uncompressed = await decodeNiftiBuffer(result.files[result.names.image]);
      const written = readNiftiFrames(uncompressed);
      if (!sameNiftiGrid(series.headerBytes, uncompressed)) throw new Error("Benchmark corrected DWI is not on the input grid.");
      if (written.frames !== series.frames || written.data.length !== series.data.length) throw new Error("Benchmark output lost volumes.");
      const nonzero = new Uint8Array(series.frames);
      for (let offset = 0; offset < written.data.length; offset++) {
        const value = written.data[offset];
        if (!Number.isFinite(value)) throw new Error(`Benchmark output contains a nonfinite value at voxel ${offset}.`);
        if (value !== 0) nonzero[Math.floor(offset / loaded.voxels)] = 1;
      }
      for (let frame = 0; frame < series.frames; frame++) {
        if (!b0[frame] && !nonzero[frame]) throw new Error(`Benchmark corrected DWI frame ${frame} contains no signal.`);
      }
      for (const [frame, originalHash] of originalB0Hashes) {
        const writtenHash = await hash(written.data.subarray(frame * voxels, (frame + 1) * voxels));
        if (writtenHash !== originalHash) throw new Error(`Benchmark changed b0 frame ${frame}.`);
      }
      const required = [result.names.image, result.names.bval, result.names.bvec, result.names.motion, result.names.sidecar,
        ...Array.from({ length: series.frames }, (_, frame) => result.names.transform(frame))];
      if (required.some(name => !result.files[name]?.byteLength)) throw new Error("Benchmark is missing a required scientific artifact.");
      const writtenBvals = numbers(result.files[result.names.bval]);
      const bvecRows = decoder.decode(result.files[result.names.bvec]).trim().split("\n");
      if (writtenBvals.length !== series.frames
        || bvecRows.length !== 3 || bvecRows.some(row => row.trim().split(/\s+/).length !== series.frames)
        || decoder.decode(result.files[result.names.motion]).trim().split("\n").length !== series.frames + 1
        || result.transforms.length !== series.frames) throw new Error("Benchmark output tables do not cover all frames.");
      if (writtenBvals.some(value => !Number.isFinite(value) || value < 0)
        || bvecRows.some(row => row.trim().split(/\s+/).map(Number).some(value => !Number.isFinite(value)))) {
        throw new Error("Benchmark gradient tables contain invalid numeric values.");
      }
      const motionRows = decoder.decode(result.files[result.names.motion]).trim().split("\n").map(row => row.trim().split(/\s+/));
      const motionColumns = motionRows[0].length;
      const displacementColumn = motionRows[0].indexOf("framewise_displacement");
      if (motionRows.slice(1).some((row, frame) => row.length !== motionColumns || row.some((text, column) => {
        if (frame === 0 && column === displacementColumn && text === "n/a") return false;
        return !Number.isFinite(Number(text));
      }))) {
        throw new Error("Benchmark motion table contains invalid numeric values.");
      }
      if (result.transforms.some(transform => [...transform.parameters, ...transform.fixed].some(value => !Number.isFinite(value)))) {
        throw new Error("Benchmark transforms contain nonfinite values.");
      }
      const hashes = { [result.names.image]: await hash(uncompressed) };
      for (const [name, bytes] of Object.entries(result.files)) if (name !== result.names.image) hashes[name] = await hash(bytes);
      return { ...loaded, ...measured, hashes, verified: true };
    },
  };
}
