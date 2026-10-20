// DOM-free steps of the noddi workflow, shared by the web app and the noddi command line: the
// mean b0, voxel chunks for the workers, and the written maps with their BIDS derivative names
// (BEP016 dwimap).

/** The maps each model writes: BEP016 parameter label, worker output key, row label. */
export const MAPS = Object.freeze({
  tensor: [
    { param: "fa", key: "FA", label: "FA" },
    { param: "md", key: "MD", label: "MD" },
    { param: "ad", key: "AD", label: "AD" },
    { param: "rd", key: "RD", label: "RD" },
    { param: "s0", key: "S0", label: "S0" },
    { param: "direction", keys: ["V1x", "V1y", "V1z"], label: "Tensor direction" },
  ],
  noddi: [
    { param: "icvf", key: "ICVF", label: "ICVF" },
    { param: "isovf", key: "ISOVF", label: "ISOVF" },
    { param: "odi", key: "OD", label: "ODI" },
    { param: "direction", keys: ["dirx", "diry", "dirz"], label: "NODDI direction" },
  ],
});

/** The BIDS stem of a DWI file: its name without extension and without a trailing _dwi. */
export function bidsStem(fileName) {
  return fileName.replace(/\.nii(\.gz)?$/i, "").replace(/_dwi$/i, "");
}

/** BEP016 name of one parameter map: <stem>_model-<model>_param-<param>_dwimap.nii.gz. */
export function mapName(stem, model, param) {
  return `${stem}_model-${model}_param-${param}_dwimap.nii.gz`;
}

/** BIDS name of the brain mask used for the fit. */
export function maskName(stem) {
  return `${stem}_desc-brain_mask.nii.gz`;
}

/** Mean of the given volumes, voxel by voxel. `data` is volume-major. */
export function meanVolumes(data, voxels, volumes) {
  const mean = new Float32Array(voxels);
  for (const v of volumes) {
    const offset = v * voxels;
    for (let i = 0; i < voxels; i++) mean[i] += data[offset + i];
  }
  for (let i = 0; i < voxels; i++) mean[i] /= volumes.length;
  return mean;
}

/** Indices of the non-zero voxels of a mask. */
export function maskIndices(mask) {
  const indices = [];
  for (let i = 0; i < mask.length; i++) if (mask[i]) indices.push(i);
  return Uint32Array.from(indices);
}

/** Voxels per fitting job, in the browser's workers and the command line's threads alike. */
export const CHUNK_VOXELS = 2048;

/** Splits voxel indices into chunks of at most `size`. */
export function chunks(indices, size) {
  const out = [];
  for (let start = 0; start < indices.length; start += size) out.push(indices.subarray(start, start + size));
  return out;
}

/** The chunk's samples, volume-major over its voxels, as the WebAssembly fit takes them. */
export function gatherChunk(data, voxels, volumes, indices) {
  const out = new Float32Array(indices.length * volumes);
  for (let v = 0; v < volumes; v++) {
    const offset = v * voxels;
    const row = v * indices.length;
    for (let k = 0; k < indices.length; k++) out[row + k] = data[offset + indices[k]];
  }
  return out;
}

/** Full-size maps, zero outside the mask, for the outputs of one model. */
export function emptyMaps(model, voxels) {
  const maps = {};
  for (const map of MAPS[model]) {
    for (const key of map.keys ?? [map.key]) maps[key] = new Float32Array(voxels);
  }
  return maps;
}

/** Writes a chunk's outputs back to the voxel positions it came from. */
export function scatterChunk(maps, outputs, indices) {
  for (const [key, values] of Object.entries(outputs)) {
    const target = maps[key];
    if (!target) continue;
    for (let k = 0; k < indices.length; k++) target[indices[k]] = values[k];
  }
}

/** A direction map as three frames (x, y, z) after one another, as a 4D NIfTI holds them. */
export function stackFrames(maps, keys) {
  const voxels = maps[keys[0]].length;
  const out = new Float32Array(voxels * keys.length);
  keys.forEach((key, frame) => out.set(maps[key], frame * voxels));
  return out;
}

/**
 * Every file a fit writes, in the order the web app lists them: each model's maps, then the brain
 * mask. Each entry gives its automation role, row label, BIDS file name, voxel data and frame
 * count (3 for a direction, 1 otherwise).
 * @param fit.tensor tensor maps keyed by DTI output name
 * @param fit.noddi NODDI maps keyed by NODDI output name, or null for a tensor-only fit
 * @param mask the brain mask used, one value per voxel
 */
export function outputEntries({ tensor, noddi }, mask, stem) {
  const entries = [];
  for (const [model, maps] of [["tensor", tensor], ["noddi", noddi]]) {
    if (!maps) continue;
    for (const map of MAPS[model]) {
      entries.push({
        role: `${model}-${map.param}`,
        model,
        param: map.param,
        label: map.label,
        name: mapName(stem, model, map.param),
        data: map.keys ? stackFrames(maps, map.keys) : maps[map.key],
        frames: map.keys ? map.keys.length : 1,
      });
    }
  }
  entries.push({ role: "mask", model: null, param: "mask", label: "Brain mask", name: maskName(stem), data: mask, frames: 1 });
  return entries;
}
