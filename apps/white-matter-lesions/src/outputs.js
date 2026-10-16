import { labelLesions, lesionTable } from "@neurodesk/white-matter-lesions";
import { lesionList, outputNames, resampledFlairName } from "@neurodesk/white-matter-lesions/results";

export function lesionSummary({ count, totalMl }) {
  return `${count} ${count === 1 ? "lesion" : "lesions"} · ${totalMl.toFixed(2)} ml`;
}

// Rows for the statistics table; single lesions are small, so their volumes keep 3 decimals.
export function lesionStatistics(lesions) {
  const volumes = lesions.map(({ ml }) => ml).sort((a, b) => a - b);
  if (!volumes.length) return [["Lesions", "0"]];
  const middle = volumes.length >> 1;
  const median = volumes.length % 2 ? volumes[middle] : (volumes[middle - 1] + volumes[middle]) / 2;
  return [
    ["Lesions", String(volumes.length)],
    ["Total volume", `${volumes.reduce((sum, ml) => sum + ml, 0).toFixed(2)} ml`],
    ["Largest", `${volumes.at(-1).toFixed(3)} ml`],
    ["Median", `${median.toFixed(3)} ml`],
    ["Smallest", `${volumes[0].toFixed(3)} ml`],
  ];
}

export function segmentationOutputs(inputName, { mask, probability, tsv, summary, lesions, resampledFlair }) {
  const names = outputNames(inputName);
  return {
    ...(resampledFlair && {
      flair: { description: "FLAIR · downsampled for FLAMeS", file: new File([resampledFlair], resampledFlairName(inputName)) },
    }),
    mask: { description: `Lesion mask · ${lesionSummary(summary)}`, editable: true, lesions, file: new File([mask], names.mask) },
    probability: { description: "Lesion probability", file: new File([probability], names.probability) },
    table: { description: "Lesion table (TSV)", viewable: false, file: new File([tsv], names.table, { type: "text/tab-separated-values" }) },
  };
}

export function applyMaskEdit(outputs, file, original, volume) {
  const table = lesionTable(labelLesions(volume.data, volume.dims).lesions, volume.affine);
  const summary = lesionSummary({ count: table.rows.length, totalMl: table.totalMl });
  return {
    ...outputs,
    mask: { ...outputs.mask, description: `Lesion mask · ${summary}`, lesions: lesionList(table.rows), file, original: outputs.mask.original ?? original, edited: true },
    table: {
      ...outputs.table,
      file: new File([table.tsv], outputs.table.file.name, { type: outputs.table.file.type }),
      original: outputs.table.original ?? outputs.table.file,
      edited: true,
    },
  };
}
