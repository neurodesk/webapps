// DOM-independent app config for AURORA.
import { LABELS } from "@neurodesk/aurora/results";
import { DEFAULT_THRESHOLD } from "@neurodesk/aurora";

export const APP = Object.freeze({
  id: "aurora",
  title: "AURORA",
});

export const THRESHOLD_RANGE = Object.freeze({ min: 0.05, max: 0.95, default: DEFAULT_THRESHOLD });

export function normalizeThreshold(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < THRESHOLD_RANGE.min || num > THRESHOLD_RANGE.max) {
    throw new Error(`Probability threshold must be between ${THRESHOLD_RANGE.min} and ${THRESHOLD_RANGE.max}.`);
  }
  return num;
}

// Distinct high-contrast colours for the two AURORA output regions:
//   1 = peritumoral oedema (green)
//   2 = metastasis (enhancing + necrosis, bright yellow-orange)
export const LABEL_COLORS = Object.freeze({
  1: Object.freeze([64, 200, 96]),
  2: Object.freeze([255, 196, 0]),
});

/** NiiVue label colour map with transparent background. */
export function labelColormap() {
  return {
    R: [0, ...LABELS.map(({ value }) => LABEL_COLORS[value][0])],
    G: [0, ...LABELS.map(({ value }) => LABEL_COLORS[value][1])],
    B: [0, ...LABELS.map(({ value }) => LABEL_COLORS[value][2])],
    A: [0, 255, 255],
    I: [0, ...LABELS.map(({ value }) => value)],
    labels: ["", ...LABELS.map(({ name }) => name)],
  };
}

/** LabelLegend rows and volumes (mL) for the two AURORA regions. */
export function legendOf(rows) {
  const labels = LABELS.map(({ value, name }) => ({ index: value, name, color: [...LABEL_COLORS[value], 255] }));
  const labelVolumes = Object.fromEntries(rows.filter(({ id }) => /^\d$/.test(id)).map(({ id, ml }) => [Number(id), ml]));
  return { labels, metrics: { labelVolumes } };
}
