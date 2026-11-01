// DOM-independent app config. Kept pure so it can be unit-tested under Node
// without a browser (see test/config.test.js).
import automation from "../automation.json" with { type: "json" };
import { localCsv, subjectId, tableCsv, totCsv } from "@neurodesk/brainqcnet/summary";
import { splitName } from "@neurodesk/webapp-components/file-io/bids-derivatives";

export const APP = Object.freeze({
  id: "brainqcnet",
  title: automation.title,
});

const { method, areas, backend } = automation.operations["check-quality"].parameters;
export const SETTINGS = Object.freeze({
  method: Object.freeze({ values: Object.freeze([...method.enum]), default: method.default }),
  areas: Object.freeze({ min: areas.minimum, max: areas.maximum, default: areas.default }),
  backend: Object.freeze({ values: Object.freeze([...backend.enum]), default: backend.default }),
});

/** The run settings from form or automation values; a value outside its range is refused. */
export function qualitySettings(values = {}) {
  const settings = {
    method: values.method ?? SETTINGS.method.default,
    areas: values.areas ?? SETTINGS.areas.default,
    backend: values.backend ?? SETTINGS.backend.default,
  };
  if (!SETTINGS.method.values.includes(settings.method)) {
    throw new Error(`Choose the ${SETTINGS.method.values.join(", ")} method.`);
  }
  const { min, max } = SETTINGS.areas;
  if (!Number.isSafeInteger(settings.areas) || settings.areas < min || settings.areas > max) {
    throw new Error(`Areas per axis must be a whole number from ${min} to ${max}.`);
  }
  if (!SETTINGS.backend.values.includes(settings.backend)) {
    throw new Error(`Choose the ${SETTINGS.backend.values.join(", ")} backend.`);
  }
  return settings;
}

/** Why an image cannot be checked, or null: BrainQCNet slices one 3D volume. */
export function volumeRefusal({ dimensionality, frames, dims }) {
  if (frames > 1) return `This image has ${frames} volumes. Choose one 3D T1-weighted volume.`;
  if (dimensionality !== 3) return `This image is ${dims.join(" × ")}, not a 3D volume. Choose a 3D T1-weighted image.`;
  return null;
}

/** The input's BIDS stem with its suffix, e.g. sub-01_acq-standard_T1w. */
function inputStem(inputName) {
  const [stem, suffix] = splitName(inputName);
  return suffix ? `${stem}_${suffix}` : stem;
}

const TABLES = Object.freeze([
  ["table", "table.csv", "every slice", (summary) => tableCsv(summary)],
  ["summary", "tot_df.csv", "summary", (summary, inputName, seconds) => totCsv(summary, subjectId(inputName), seconds)],
  ...["x", "y", "z"].map((axis) => [`${axis}Areas`, `${axis}_results_locally.csv`, `${axis} areas`, (summary) => localCsv(summary, axis)]),
]);

/**
 * The BIDS app's five tables, named as it names them after the input stem, with a label
 * that leads with that name. `seconds` is the processing time tot_df.csv records as `t`.
 */
export function reportFiles(inputName, summary, seconds) {
  const stem = inputStem(inputName);
  return Object.fromEntries(TABLES.map(([role, file, label, write]) => [role, {
    name: `${stem}_${file}`,
    label: `${file} · ${label}`,
    text: write(summary, inputName, seconds),
  }]));
}

export function mapName(inputName) {
  return `${inputStem(inputName)}_flaggedslices.nii.gz`;
}

const percent = (fraction) => `${Math.round(fraction * 100)} %`;
const METHOD_LABELS = Object.freeze({ percentage: "Slices flagged", mean: "Mean prediction", median: "Median prediction" });

/** The verdict and per-axis rows shown in the Output section. */
export function verdictRows(summary) {
  const value = summary.method === "percentage" ? percent : (p) => p.toFixed(2);
  const verdict = (pred) => (pred === 1 ? "artifact" : "no artifact");
  return [
    { label: "Verdict", value: summary.pred === 1 ? "Artifact detected" : "No artifact detected", flag: true },
    { label: METHOD_LABELS[summary.method], value: value(summary.proba) },
    ...["x", "y", "z"].map((axis) => ({
      label: `${axis} slices`,
      value: `${value(summary.axes[axis].proba)} · ${verdict(summary.axes[axis].pred)}`,
    })),
  ];
}

/** The status line after a run. */
export function verdictStatus(summary) {
  const [verdict, overall] = verdictRows(summary);
  return `${verdict.value} · ${overall.label.toLowerCase()} ${overall.value}`;
}
