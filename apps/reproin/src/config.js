// DOM-independent app logic, unit-tested under Node (test/config.test.js).
export const APP = Object.freeze({
  id: "reproin",
  version: "0.0.20261030",
});

// Top-level folder inside the downloaded ZIP.
export const DATASET = "bids";

const label = (value) => String(value ?? "").trim();

// Form or automation values -> convertToBids options. Empty labels defer to dcm2niix.
export function conversionOptions({ subject, session, anonymize, shiftDates, keepDerivatives } = {}) {
  return {
    subject: label(subject),
    session: label(session),
    anonymize: Boolean(anonymize),
    shiftDates: Boolean(shiftDates),
    keepDerivatives: Boolean(keepDerivatives),
  };
}

const isNifti = (path) => /\.nii(\.gz)?$/.test(path);

// Sidebar rows truncate their end, so show "anat/acq-tfl3_T1w.nii.gz" rather than the full path:
// parent folder plus the file name without its sub-/ses- entities, which the folders already state.
// ponytail: rows of different sessions can look alike; the ZIP and file names keep them apart.
export function shortLabel(path) {
  const parts = path.split("/");
  const name = parts.pop().replace(/^sub-[^_]+_(ses-[^_]+_)?/, "");
  return parts.length ? `${parts.pop()}/${name}` : name;
}

// Result rows: the ZIP first, then every dataset file by path. Only NIfTI opens in the viewer.
export function resultRows(tree, dataset) {
  const rows = { [dataset.name]: { description: `BIDS dataset (${dataset.name})`, file: dataset, viewable: false } };
  for (const path of [...tree.keys()].sort()) {
    rows[path] = { description: shortLabel(path), path, file: new File([tree.get(path)], path.split("/").pop()), viewable: isNifti(path) };
  }
  return rows;
}
