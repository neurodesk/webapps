// DOM-free steps of the SyN-SDC method: choosing the DWI series and the T1w among the inputs,
// which acquisition fields the sidebar must ask for, the stage messages, and the QC numbers.
import { parseBidsName, readBidsDiffusion } from "@neurodesk/webapp-components/file-io/bids";
import { bidsFile } from "./pipeline.js";

/**
 * The DWI run and the T1w of a BIDS selection (flat BIDS names count), or null when the
 * NIfTI/DICOM reader must read the files instead: they hold no BIDS DWI run, or the DWI has flat
 * BIDS names (not in a dataset's folders) and no T1w matches it by name, as with an
 * anatomy.nii.gz or a DICOM T1w beside sub-01_dwi.nii.gz.
 */
export async function selectBidsSyn(files) {
  const layout = files.map(bidsFile);
  const placed = new Set(layout.filter((file, i) => file !== files[i]));
  const { runs } = await readBidsDiffusion(layout);
  if (!runs.length) return null;
  const complete = runs.filter((run) => run.bval && run.bvec);
  if (complete.length !== 1) {
    throw new Error(complete.length ? `Choose one DWI run; this selection has ${complete.length}.` : `${runs[0].path} needs its bval and bvec.`);
  }
  const [run] = complete;
  if (!run.t1w && placed.has(run.dwi)) return null;
  if (!run.t1w) throw new Error(`No T1w image of sub-${run.subject}: add its anat/*_T1w.nii.gz.`);
  return { image: run.dwi, bval: run.bval, bvec: run.bvec, sidecar: run.sidecar, t1w: run.t1w };
}

/**
 * The DWI series (the one with a bval and a bvec) and the T1w among loose series: the image named
 * *_T1w, else the one other image.
 * @param series [{ image: File, bval: File|null, bvec: File|null, sidecar }]
 */
export function selectSynSeries(series) {
  const dwi = series.filter((entry) => entry.bval && entry.bvec);
  if (dwi.length !== 1) throw new Error(`Choose one DWI series with its bval and bvec, and a T1w image; this selection has ${dwi.length} DWI series.`);
  const others = series.filter((entry) => !entry.bval && !entry.bvec);
  const named = others.filter((entry) => parseBidsName(entry.image.name).suffix === "T1w");
  const t1w = named.length ? named : others;
  if (!t1w.length) throw new Error("SyN-SDC needs a T1-weighted image of the same session.");
  if (t1w.length > 1) throw new Error("Choose one T1w image, or name it *_T1w.nii.gz.");
  return { ...dwi[0], t1w: t1w[0].image };
}

/** The acquisition fields that no sidecar gives, which the sidebar then asks for. */
export function missingAcquisition(sidecar) {
  return {
    direction: !sidecar?.PhaseEncodingDirection,
    readout: sidecar?.TotalReadoutTime == null && !sidecar?.EffectiveEchoSpacing,
  };
}

/** The status message and progress fraction of each stage of packages/sdc's pipeline. */
const STAGES = {
  reference: ["Building the EPI reference (mean b0, N4)", 0.01],
  masks: ["Brain masks", 0.03],
  anatomical: ["Denoising the T1w", 0.06],
  affine: ["Registering the mean b0 to the T1w and the T1w to MNI", 0.1],
  resample: ["Resampling to the SyN grid", 0.6],
  laplacian: ["Laplacian channels", 0.62],
  syn: ["Registering with SyN along the phase-encoding axis", 0.64],
  field: ["Fitting the field map", 0.9],
  unwarp: ["Unwarping the DWI series", 0.92],
  write: ["Writing the outputs", 0.99],
};

/** One progress event of the pipeline as { message, fraction }. */
export function stageProgress({ stage, done, total }) {
  const [message, fraction] = STAGES[stage] ?? [stage, 0];
  if (stage === "unwarp" && total) return { message: `${message}: ${done}/${total}`, fraction: fraction + 0.07 * (done / total) };
  return { message, fraction };
}

/**
 * The field inside the brain mask: the median, 95th percentile and largest |field| in Hz, and the
 * largest shift in voxels along the phase-encoding axis (|field| × TotalReadoutTime).
 */
export function fieldSummary(field, mask, totalReadoutTime) {
  const values = Float64Array.from(field.filter((_, i) => mask[i] > 0), Math.abs).sort();
  if (!values.length) throw new Error("The brain mask is empty.");
  const quantile = (q) => values[Math.min(values.length - 1, Math.floor(q * values.length))];
  const max = values[values.length - 1];
  return { voxels: values.length, median: quantile(0.5), p95: quantile(0.95), max, shift: max * totalReadoutTime };
}

/** The console's QC line for a fieldSummary. */
export function fieldSummaryText({ voxels, median, p95, max, shift }, direction) {
  return `Field in the DWI brain mask (${voxels} voxels): median |f| ${median.toFixed(2)} Hz, 95th percentile ${p95.toFixed(2)} Hz, largest ${max.toFixed(2)} Hz, a shift of ${shift.toFixed(2)} voxels along ${direction}`;
}
