import { labelLesions, lesionTable } from "@neurodesk/white-matter-lesions";
import { outputNames } from "@neurodesk/white-matter-lesions/results";

export function lesionSummary({ count, totalMl }) {
  return `${count} ${count === 1 ? "lesion" : "lesions"} · ${totalMl.toFixed(2)} ml`;
}

export function segmentationOutputs(inputName, { mask, probability, tsv, summary }) {
  const names = outputNames(inputName);
  return {
    mask: { description: `Lesion mask · ${lesionSummary(summary)}`, editable: true, file: new File([mask], names.mask) },
    probability: { description: "Lesion probability", file: new File([probability], names.probability) },
    table: { description: "Lesion table (TSV)", viewable: false, file: new File([tsv], names.table, { type: "text/tab-separated-values" }) },
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
