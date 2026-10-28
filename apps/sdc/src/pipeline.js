// DOM-free steps of the sdc workflow: pairing the inputs, choosing b = 0 volumes, averaging
// them and naming the outputs.
import { isReversePair, phaseEncoding } from "@neurodesk/sdc";
import { parseBidsName, readBidsDiffusion } from "@neurodesk/webapp-components/file-io/bids";

/** Volumes with a b-value at or below this count as b = 0, as in the options document. */
export const B0_MAX = 50;

/**
 * The two series of a reverse phase-encoding pair. Image 1 is the field's reference: the DWI
 * series (the one with a bval) when exactly one has a bval, otherwise the first by name.
 * @param series [{ image: File, sidecar, bval: File|null }]
 */
export function selectPair(series, { ordered = false } = {}) {
  const candidates = series.filter((entry) => entry.sidecar?.PhaseEncodingDirection);
  const missing = series.filter((entry) => !entry.sidecar?.PhaseEncodingDirection).map((entry) => entry.image.name);
  if (candidates.length !== 2) {
    const without = missing.length ? ` ${missing.join(", ")} ${missing.length === 1 ? "has" : "have"} no sidecar with PhaseEncodingDirection.` : "";
    throw new Error(`Choose two images with opposite phase-encoding directions, each with its JSON sidecar; this selection has ${candidates.length}.${without}`);
  }
  const [a, b] = ordered ? candidates : [...candidates].sort((x, y) => x.image.name.localeCompare(y.image.name));
  const subjects = new Set([a, b].map((entry) => parseBidsName(entry.image.name).entities.sub).filter(Boolean));
  if (subjects.size > 1) throw new Error("The images must belong to the same subject.");
  for (const entry of [a, b]) phaseEncoding(entry.sidecar.PhaseEncodingDirection);
  if (!isReversePair(a.sidecar.PhaseEncodingDirection, b.sidecar.PhaseEncodingDirection)) {
    throw new Error(`The images need opposite directions on one axis, not ${a.sidecar.PhaseEncodingDirection} and ${b.sidecar.PhaseEncodingDirection}.`);
  }
  for (const entry of [a, b]) {
    const readout = entry.sidecar.TotalReadoutTime;
    if (typeof readout !== "number" || !Number.isFinite(readout) || readout <= 0) {
      throw new Error(`${entry.image.name} needs a finite positive TotalReadoutTime in its sidecar.`);
    }
  }
  if (a.sidecar.TotalReadoutTime !== b.sidecar.TotalReadoutTime) {
    throw new Error("The images need the same TotalReadoutTime: PyHySCO assumes equal and opposite displacements.");
  }
  return ordered || a.bval || !b.bval ? [a, b] : [b, a];
}

/** Give flat BIDS-named files their declared subject/session layout for the shared reader. */
function bidsFile(file) {
  if (file.webkitRelativePath || file._webkitRelativePath) return file;
  const { entities, suffix } = parseBidsName(file.name);
  const datatype = { dwi: "dwi", epi: "fmap", T1w: "anat" }[suffix];
  if (!entities.sub || !datatype) return file;
  const copy = new File([file], file.name, { type: file.type, lastModified: file.lastModified });
  const directory = [`sub-${entities.sub}`, ...(entities.ses ? [`ses-${entities.ses}`] : []), datatype];
  Object.defineProperty(copy, "webkitRelativePath", { value: [...directory, file.name].join("/") });
  return copy;
}

/**
 * Select one reverse pair from the shared BIDS reader's IntendedFor associations. A pair of
 * associated fieldmaps takes precedence over the DWI; one fieldmap pairs with its DWI.
 * Returns null for a loose selection that the shared NIfTI/DICOM reader must read instead.
 */
export async function selectBidsPair(files) {
  const layout = files.map(bidsFile);
  const { runs } = await readBidsDiffusion(layout);
  if (!runs.length) return null;
  const paths = new Set();
  for (const file of layout) {
    const path = file.webkitRelativePath || file._webkitRelativePath || file.name;
    if (paths.has(path)) throw new Error(`Repeated BIDS input path ${path}; choose one dataset or pair.`);
    paths.add(path);
  }
  const subjects = new Set(runs.map((run) => `${run.root}\0${run.subject}`));
  if (subjects.size > 1) throw new Error("Choose images from one subject and dataset.");
  const candidates = new Map();
  for (const run of runs) {
    if (run.entities.sub && run.entities.sub !== run.subject) throw new Error("BIDS paths and image names must identify the same subject.");
    if (!run.fieldmaps.length) continue;
    for (const fieldmap of run.fieldmaps) {
      if (!fieldmap.path.startsWith(`sub-${run.subject}/`) || (fieldmap.entities.sub && fieldmap.entities.sub !== run.subject)) {
        throw new Error("IntendedFor fieldmaps and their DWI must belong to the same subject.");
      }
    }
    const entries = run.fieldmaps.map((fieldmap) => ({ image: fieldmap.file, sidecar: fieldmap.sidecar, bval: null, path: `${run.root}/${fieldmap.path}` }));
    if (entries.length === 1) entries.unshift({ image: run.dwi, sidecar: run.sidecar, bval: run.bval, path: `${run.root}/${run.path}` });
    if (entries.length !== 2) throw new Error("IntendedFor identifies more than one reverse pair; choose one pair explicitly.");
    const pair = selectPair(entries);
    candidates.set(pair.map((entry) => entry.path).sort().join("\0"), pair);
  }
  if (candidates.size > 1) throw new Error("IntendedFor identifies more than one reverse pair; choose one pair explicitly.");
  if (candidates.size === 1) return candidates.values().next().value;
  if (runs.length === 2) return selectPair(runs.map((run) => ({ image: run.dwi, sidecar: run.sidecar, bval: run.bval })));
  if (files.some((file) => file.webkitRelativePath || file._webkitRelativePath)) {
    throw new Error("No unambiguous reverse pair: fieldmaps need IntendedFor naming their DWI.");
  }
  return null;
}

/** The indices of the b = 0 volumes: those with b ≤ B0_MAX, or every volume without a bval. */
export function b0Frames(bvalText, frames) {
  if (bvalText == null) return Array.from({ length: frames }, (_, k) => k);
  const values = bvalText.trim().split(/\s+/).filter(Boolean).map(Number);
  if (values.length !== frames || values.some((v) => !Number.isFinite(v))) {
    throw new Error(`The bval has ${values.length} values for ${frames} volumes.`);
  }
  const keep = values.flatMap((v, k) => (v <= B0_MAX ? [k] : []));
  if (!keep.length) throw new Error(`The series has no volume with b ≤ ${B0_MAX}.`);
  return keep;
}

/** The voxel-wise mean of the chosen volumes, as Float64, summed in volume order. */
export function meanFrames(data, voxels, frames) {
  const out = new Float64Array(voxels);
  for (const frame of frames) {
    const offset = frame * voxels;
    for (let i = 0; i < voxels; i++) out[i] += data[offset + i];
  }
  for (let i = 0; i < voxels; i++) out[i] /= frames.length;
  return out;
}

/** The lengths of the affine's first three columns: the voxel size nibabel gives PyHySCO. */
export function voxelSizes(affine) {
  return [0, 1, 2].map((j) => Math.hypot(affine[0][j], affine[1][j], affine[2][j]));
}

/** BIDS stem of an image name, without its suffix and any desc entity. */
export function bidsStem(fileName) {
  const base = fileName.replace(/\.nii(\.gz)?$/i, "");
  const match = base.match(/^(.*)_([A-Za-z0-9]+)$/);
  const stem = match ? match[1] : base;
  return stem.split("_").filter((entity) => !entity.startsWith("desc-")).join("_");
}

/** Output names: the field map and the two quality-control images. */
export function outputNames(name1, name2) {
  const [stem1, stem2] = [bidsStem(name1), bidsStem(name2)];
  return {
    field: `${stem1}_fieldmap.nii.gz`,
    sidecar: `${stem1}_fieldmap.json`,
    corrected1: `${stem1}_desc-pyhyscoQC_b0.nii.gz`,
    corrected2: `${stem2 === stem1 ? `${stem2}_rev` : stem2}_desc-pyhyscoQC_b0.nii.gz`,
  };
}

/** The backend that made the field, as the worker reports it: the adapter on WebGPU, the GPU error when `auto` fell back to the CPU. */
export function fieldExecution({ backend, adapter, gpuError }) {
  const execution = { backend };
  if (adapter) execution.adapter = adapter;
  if (gpuError) execution.gpuError = gpuError;
  return execution;
}

/** The automation report's provenance for one field estimate. */
export function fieldProvenance({ iterations, reference, phaseEncodingDirection, totalReadoutTime, execution }) {
  return { method: "pyhysco-0.0.4-port", alpha: 300, beta: 1e-4, maxIterations: 50, iterations, reference, phaseEncodingDirection, totalReadoutTime, execution };
}

/** The field map's sidecar. */
export function fieldSidecar({ image1, image2, phaseEncodingDirection, totalReadoutTime, iterations, execution }) {
  return {
    Units: "Hz",
    Sources: [image1, image2],
    PhaseEncodingDirection: phaseEncodingDirection,
    TotalReadoutTime: totalReadoutTime,
    Execution: execution,
    Description: `Susceptibility field from a reverse phase-encoding pair: PyHySCO 0.0.4 defaults (sdc app port), ${iterations} Gauss-Newton iterations. Sign as FSL topup: image 1 corrected is image1(x + field * TotalReadoutTime * PE sign) voxels.`,
  };
}
