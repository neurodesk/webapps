// Replays NiFreeze's kept registrations through the WebAssembly kernel (#446).
//
//   node validation/nifreeze-replay.mjs <HMC_REFERENCE> <OUT>
//
// <HMC_REFERENCE> holds the nifreeze-replay subset of exes/dwi/hmc/validation/reference.manifest.json.
// For each of the 90 GP volumes it runs the kept nifreeze-gp/work/cmd-NNNNN.sh: the words as the
// shell gave them to native ANTs, host directories reduced to file names, plus `--float 1` and
// `--random-seed 1234` (the native runs set ANTS_RANDOM_SEED=1234; native ANTs gives the same
// bytes either way). It writes OUT/gp/ants-NNNNN0GenericAffine.mat.
//
// For the 11 b0 pairs of q53-b0/ it remakes each moving image as scripts/q53_b0.py did with
// nibabel 5.4.2: the b0 volume of input/sub-107_dir-AP_dwi.nii.gz as float32, written with the 4D
// header (int16, so nibabel scales it; see nibabelInt16Volume), and registers it to the trivial
// prediction with nifreeze-trivial-a1/work/cmd-00000.sh. It writes OUT/b0/float-KKK_0GenericAffine.mat.
//
// OUT/timing.json gives the seconds of each run. exes/dwi/hmc/tests/q53_replay.rs reads OUT.
//
// HMC_WASM_DIR, a directory with another build's hmc-registration.{mjs,wasm} (for example
// sdc-gate/build-wasm.sh's), replays that build instead of the committed kernel, as in
// sdc-gate/ants-cli.mjs; OUT/timing.json then records its SHA-256.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { createHmcRegistration } from "../src/index.js";
import { loadHmcRegistration } from "../src/node.js";

const HOST = "/var/tmp/dwi-hmc/runs/";
const SEED = "1234";
const GP_VOLUMES = 90;
const B0_VOLUMES = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100];

// One kernel instance runs all 101 registrations (#537): the committed one, or HMC_WASM_DIR's.
async function kernel(dir) {
  let ants = null;
  let wasmSha256 = null;
  if (dir) {
    const wasmBinary = await readFile(join(dir, "hmc-registration.wasm"));
    const { default: createModule } = await import(pathToFileURL(join(dir, "hmc-registration.mjs")).href);
    ants = await createHmcRegistration({ createModule, wasmBinary });
    wasmSha256 = createHash("sha256").update(wasmBinary).digest("hex");
  } else {
    ants = await loadHmcRegistration();
  }
  const run = async (argv, inputs) => {
    const start = performance.now();
    const { outputs } = ants.run(argv, inputs);
    return { outputs, seconds: (performance.now() - start) / 1000 };
  };
  return { run, wasmSha256 };
}

/** The kept command as the shell split it, with host directories removed and the port's flags. */
export function replayArgv(command, run) {
  const words = command.trim().split(/\s+/);
  if (words[0] !== "antsRegistration") throw new Error("not an antsRegistration command");
  const prefix = `${HOST}${run}/work/`;
  return [...words.slice(1).map((word) => word.replaceAll(prefix, "")), "--float", "1", "--random-seed", SEED];
}

/** NumPy's rint: round half to even. */
function rint(x) {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/**
 * Volume `k` of a 4D int16 NIfTI-1 file, as nibabel 5.4.2 writes `Nifti1Image(vol.astype(float32),
 * affine, header)`: the header keeps int16, so nibabel's SlopeInterArrayWriter maps the float32
 * range [mn, mx] onto [-32768, 32767] with a float32 slope (mx - mn) / 65535 and intercept
 * mn + 32768 slope, and writes rint((x - inter) / slope) computed in float32, clipped. Only
 * dim, pixdim[4..7] and scl_slope/scl_inter change in the header.
 */
export function nibabelInt16Volume(nifti, k) {
  const view = new DataView(nifti.buffer, nifti.byteOffset, nifti.byteLength);
  if (view.getInt32(0, true) !== 348 || view.getInt16(40, true) !== 4 || view.getInt16(70, true) !== 4) {
    throw new Error("expected a little-endian 4D int16 NIfTI-1 file");
  }
  const slope0 = view.getFloat32(112, true);
  const inter0 = view.getFloat32(116, true);
  if (!(Number.isNaN(slope0) || slope0 === 0 || (slope0 === 1 && inter0 === 0))) throw new Error("scaled input");
  const [nx, ny, nz] = [1, 2, 3].map((d) => view.getInt16(40 + 2 * d, true));
  const voxels = nx * ny * nz;
  const offset = view.getFloat32(108, true) + 2 * voxels * k;
  const values = new Float32Array(voxels);
  let mn = Infinity;
  let mx = -Infinity;
  for (let i = 0; i < voxels; i++) {
    const v = view.getInt16(offset + 2 * i, true);
    values[i] = v;
    mn = Math.min(mn, v);
    mx = Math.max(mx, v);
  }
  const slope = Math.fround((mx - mn) / 65535);
  const inter = Math.fround(mn + 32768 * ((mx - mn) / 65535));
  const header = nifti.slice(0, 352);
  const out = new DataView(new ArrayBuffer(352 + 2 * voxels));
  new Uint8Array(out.buffer).set(header);
  out.setInt16(40, 3, true);
  out.setInt16(48, 1, true);
  for (let d = 4; d <= 7; d++) out.setFloat32(76 + 4 * d, 1, true);
  out.setFloat32(108, 352, true);
  out.setFloat32(112, slope, true);
  out.setFloat32(116, inter, true);
  for (let i = 0; i < voxels; i++) {
    const scaled = rint(Math.fround(Math.fround(values[i] - inter) / slope));
    out.setInt16(352 + 2 * i, Math.min(32767, Math.max(-32768, scaled)), true);
  }
  return new Uint8Array(out.buffer);
}

async function main(reference, outDir) {
  const { run, wasmSha256 } = await kernel(process.env.HMC_WASM_DIR);
  const timing = { ...(wasmSha256 && { wasm_sha256: wasmSha256 }), gp: [], b0: [] };
  const gp = join(reference, "nifreeze-gp/work");
  await mkdir(join(outDir, "gp"), { recursive: true });
  const mask = await readFile(join(gp, "brainmask.nii.gz"));
  for (let v = 0; v < GP_VOLUMES; v++) {
    const id = String(v).padStart(5, "0");
    const argv = replayArgv(await readFile(join(gp, `cmd-${id}.sh`), "utf8"), "nifreeze-gp");
    const inputs = {
      [`predicted_${id}.nii.gz`]: await readFile(join(gp, `predicted_${id}.nii.gz`)),
      [`sample_${id}.nii.gz`]: await readFile(join(gp, `sample_${id}.nii.gz`)),
      "brainmask.nii.gz": mask,
    };
    const { outputs, seconds } = await run(argv, inputs);
    timing.gp.push(seconds);
    await writeFile(join(outDir, "gp", `ants-${id}0GenericAffine.mat`), outputs[`ants-${id}0GenericAffine.mat`]);
  }

  const a1 = join(reference, "nifreeze-trivial-a1/work");
  const template = await readFile(join(a1, "cmd-00000.sh"), "utf8");
  const dwi = gunzipSync(await readFile(join(reference, "input/sub-107_dir-AP_dwi.nii.gz")));
  const fixed = await readFile(join(a1, "predicted_00000.nii.gz"));
  const b0Mask = await readFile(join(a1, "brainmask.nii.gz"));
  await mkdir(join(outDir, "b0"), { recursive: true });
  for (const k of B0_VOLUMES) {
    const id = String(k).padStart(3, "0");
    const argv = replayArgv(template, "nifreeze-trivial-a1").map((word) => word.replaceAll("sample_00000.nii.gz", `b0_${id}.nii`));
    argv[argv.indexOf("--output") + 1] = `float-${id}_`;
    const inputs = {
      "predicted_00000.nii.gz": fixed,
      [`b0_${id}.nii`]: nibabelInt16Volume(dwi, k),
      "brainmask.nii.gz": b0Mask,
    };
    const { outputs, seconds } = await run(argv, inputs);
    timing.b0.push(seconds);
    await writeFile(join(outDir, "b0", `float-${id}_0GenericAffine.mat`), outputs[`float-${id}_0GenericAffine.mat`]);
  }
  await writeFile(join(outDir, "timing.json"), `${JSON.stringify(timing, null, 2)}\n`);
  const all = [...timing.gp, ...timing.b0].sort((a, b) => a - b);
  console.log(`${all.length} registrations, median ${all[all.length >> 1].toFixed(2)} s, max ${all.at(-1).toFixed(2)} s per volume`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.length !== 4) throw new Error("usage: node validation/nifreeze-replay.mjs <HMC_REFERENCE> <OUT>");
  await main(process.argv[2], process.argv[3]);
}
