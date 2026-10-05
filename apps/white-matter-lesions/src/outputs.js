import { labelLesions, lesionTable } from "@neurodesk/white-matter-lesions";

export function lesionSummary({ count, totalMl }) {
  return `${count} ${count === 1 ? "lesion" : "lesions"} · ${totalMl.toFixed(2)} ml`;
}

export function segmentationOutputs(stem, { mask, probability, tsv, summary }) {
  return {
    mask: { description: `Lesion mask · ${lesionSummary(summary)}`, editable: true, file: new File([mask], `${stem}_lesions.nii`) },
    probability: { description: "Lesion probability", file: new File([probability], `${stem}_lesion_probability.nii`) },
    table: { description: "Lesion table (TSV)", viewable: false, file: new File([tsv], `${stem}_lesions.tsv`, { type: "text/tab-separated-values" }) },
  };
}

export function applyMaskEdit(outputs, file, original, volume) {
  const table = lesionTable(labelLesions(volume.data, volume.dims).lesions, volume.affine);
  const summary = lesionSummary({ count: table.rows.length, totalMl: table.totalMl });
  return {
    ...outputs,
    mask: { ...outputs.mask, description: `Lesion mask · ${summary}`, file, original: outputs.mask.original ?? original, edited: true },
    table: {
      ...outputs.table,
      file: new File([table.tsv], outputs.table.file.name, { type: outputs.table.file.type }),
      original: outputs.table.original ?? outputs.table.file,
      edited: true,
    },
  };
}
