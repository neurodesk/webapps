// Per-class TBI lesion volume summaries, NIfTI label export, CSV export, and parity comparison metrics for BLAST-CT.
import { createUint8Nifti } from '@neurodesk/webapp-components/file-io/nifti';
import { CLASSES } from './pipeline.js';

const NIFTI_INTENT_LABEL = 1002;
const LABEL_DESCRIP = 'BLAST-CT TBI lesion segmentation';

/**
 * Build a uint8 NIfTI-1 byte buffer preserving the input volume's sform/qform geometry
 * while resetting CT-specific display/metadata fields (`cal_min`, `cal_max`, `intent_code`, `descrip`).
 */
export function writeLabelNifti(labels, dims, headerBytes) {
  if (!headerBytes) {
    throw new Error('Source NIfTI headerBytes are required to write a native-space label map.');
  }
  const out = new Uint8Array(createUint8Nifti(labels, headerBytes, dims));
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  dv.setInt16(68, NIFTI_INTENT_LABEL, true);
  dv.setFloat32(124, 4, true); // cal_max
  dv.setFloat32(128, 0, true); // cal_min
  out.fill(0, 148, 228); // descrip (80 bytes)
  for (let i = 0; i < LABEL_DESCRIP.length && i < 79; i++) {
    out[148 + i] = LABEL_DESCRIP.charCodeAt(i);
  }
  return out;
}

/**
 * Compute per-class native-space lesion volumes (in mL and voxels), matching
 * `blast_ct.nifti.savers.add_predicted_volumes_to_dataframe`.
 */
export function measureLesions(labels, spacingMm) {
  const voxelMl = (spacingMm[0] * spacingMm[1] * spacingMm[2]) / 1000;
  const counts = new Int32Array(5);
  for (let i = 0; i < labels.length; i++) {
    const v = labels[i];
    if (v >= 0 && v < 5) counts[v]++;
  }

  let totalVoxels = 0;
  let totalVolumeMl = 0;
  const classes = CLASSES.map((cls) => {
    const voxels = counts[cls.id];
    const volumeMl = voxels * voxelMl;
    totalVoxels += voxels;
    totalVolumeMl += volumeMl;
    return {
      id: cls.id,
      key: cls.key,
      shortLabel: cls.shortLabel,
      label: cls.label,
      voxels,
      volumeMl: Number(volumeMl.toFixed(2)),
      exactVolumeMl: volumeMl,
    };
  });

  return {
    voxelMl,
    totalVoxels,
    totalVolumeMl: Number(totalVolumeMl.toFixed(2)),
    classes,
  };
}

/** Format a clean RFC 4180 CSV report of per-class TBI lesion volumes. */
export function lesionsCsv(summary, scanName = 'scan') {
  const safeName = `"${String(scanName).replace(/"/g, '""')}"`;
  const lines = ['scan,class_id,class_key,class_label,voxels,volume_ml'];
  for (const row of summary.classes) {
    lines.push(`${safeName},${row.id},${row.key},"${row.label}",${row.voxels},${row.volumeMl.toFixed(2)}`);
  }
  lines.push(`${safeName},all,total,"Total lesion burden",${summary.totalVoxels},${summary.totalVolumeMl.toFixed(2)}`);
  return `${lines.join('\n')}\n`;
}

/** Compare predicted vs reference 5-class label volumes voxel-by-voxel. */
export function compareMultiClassLabels(pred, ref) {
  if (pred.length !== ref.length) {
    throw new Error(`Label volume length mismatch: ${pred.length} vs ${ref.length}`);
  }
  let diffVoxels = 0;
  const tp = new Int32Array(5);
  const predCount = new Int32Array(5);
  const refCount = new Int32Array(5);
  for (let i = 0; i < pred.length; i++) {
    const p = pred[i];
    const r = ref[i];
    if (p !== r) diffVoxels++;
    if (p >= 0 && p < 5) predCount[p]++;
    if (r >= 0 && r < 5) refCount[r]++;
    if (p === r && p >= 0 && p < 5) tp[p]++;
  }
  const perClass = {};
  for (const cls of CLASSES) {
    const denom = predCount[cls.id] + refCount[cls.id];
    perClass[cls.key] = {
      predVoxels: predCount[cls.id],
      refVoxels: refCount[cls.id],
      dice: denom ? Number(((2 * tp[cls.id]) / denom).toFixed(6)) : 1,
    };
  }
  return {
    totalVoxels: pred.length,
    diffVoxels,
    perClass,
  };
}
