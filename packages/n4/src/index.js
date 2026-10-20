// ANTs N4BiasFieldCorrection in WebAssembly, and the DWI procedure of MRtrix
// `dwibiascorrect ants` (lib/mrtrix3/dwibiascorrect/ants.py, MPL-2.0) around it.

/** MRtrix `dwibiascorrect ants` defaults: -s 4 -b [100,3] -c [1000,0.0]. */
export const DEFAULTS = Object.freeze({ shrink: 4, bspline: [100, 3], convergence: [1000, 0] });

/** The N4BiasFieldCorrection argv for one 3D image. */
export function n4Arguments({ input, weight, corrected, bias, shrink, bspline, convergence }) {
  const args = ["-d", "3", "-i", input];
  if (weight) args.push("-w", weight);
  args.push("-o", `[${corrected},${bias}]`, "-s", String(shrink), "-b", `[${bspline.join(",")}]`, "-c", `[${convergence[0]},${convergence[1].toFixed(1)}]`);
  return args;
}

/** N4 reads by file name, so gzipped NIfTI is inflated first. */
export async function inflateNifti(bytes) {
  const input = new Uint8Array(bytes);
  if (input.length < 2 || input[0] !== 0x1f || input[1] !== 0x8b) return input;
  const stream = new Blob([input]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function createN4({ createModule, wasmBinary, onLog = () => {} }) {
  const module = await createModule({ noInitialRun: true, wasmBinary, print: onLog, printErr: onLog });
  let next = 0;
  return {
    /**
     * Runs N4 on one 3D NIfTI image, with an optional weight (mask) image on the same grid.
     * @returns {Promise<{ corrected: Uint8Array, bias: Uint8Array }>} NIfTI bytes
     */
    async correct({ image, weight = null, ...options }) {
      const settings = { ...DEFAULTS, ...options };
      const dir = `/n4-${next++}`;
      module.FS.mkdir(dir);
      const paths = { input: `${dir}/in.nii`, weight: weight ? `${dir}/weight.nii` : null, corrected: `${dir}/corrected.nii`, bias: `${dir}/bias.nii` };
      try {
        module.FS.writeFile(paths.input, await inflateNifti(image));
        if (weight) module.FS.writeFile(paths.weight, await inflateNifti(weight));
        const code = module.callMain(n4Arguments({ ...paths, ...settings }));
        if (code !== 0) throw new Error(`N4 failed (exit ${code}). See the technical log.`);
        return { corrected: module.FS.readFile(paths.corrected), bias: module.FS.readFile(paths.bias) };
      } finally {
        for (const name of module.FS.readdir(dir)) if (name !== "." && name !== "..") module.FS.unlink(`${dir}/${name}`);
        module.FS.rmdir(dir);
      }
    },
  };
}

/**
 * MRtrix's global rescaling of the N4 field: N4 can scale the image as a whole, so the field is
 * multiplied by (Σ corrected) / (Σ input) over the mask, which keeps the integral in the brain.
 */
export function rescaleBias(input, corrected, mask, bias) {
  let inputSum = 0;
  let outputSum = 0;
  for (let i = 0; i < input.length; i++) {
    if (!mask[i]) continue;
    inputSum += input[i];
    outputSum += corrected[i];
  }
  if (!(inputSum > 0) || !(outputSum > 0)) throw new Error("The mask holds no signal to correct.");
  const multiplier = outputSum / inputSum;
  return { bias: Float32Array.from(bias, (value) => value * multiplier), multiplier };
}

/** Divides every volume of a series (frame-major) by the bias field, voxel by voxel. */
export function divideVolumes(data, voxels, frames, bias) {
  const out = new Float32Array(voxels * frames);
  for (let f = 0; f < frames; f++) {
    const offset = f * voxels;
    for (let i = 0; i < voxels; i++) out[offset + i] = bias[i] !== 0 ? data[offset + i] / bias[i] : 0;
  }
  return out;
}
