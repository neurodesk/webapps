// DOM-independent app configuration, NiiVue colormap, and LabelLegend adapter for BLAST-CT.
import { CLASSES } from "@neurodesk/blastct";

export const APP = Object.freeze({
  id: "blastct",
  title: "BLAST-CT",
});

/** Default NiiVue display window for brain head CT (purely visual; inference uses [-15, 100] HU). */
export const CT_BRAIN_WINDOW = Object.freeze({ min: 0, max: 80 });

export function normalizeBackend(value) {
  return value === "wasm" ? "wasm" : "auto";
}

export function stemName(filename) {
  return String(filename || "scan").replace(/\.nii(?:\.gz)?$/i, "").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "scan";
}

export function outputName(stem, suffix) {
  return `${stemName(stem)}_blastct_${suffix}`;
}

/** NiiVue 5-class label colormap (0 = transparent, 1 = IPH, 2 = EAH, 3 = Oedema, 4 = IVH). */
export function labelColormap() {
  return {
    R: [0, ...CLASSES.map((c) => c.color[0])],
    G: [0, ...CLASSES.map((c) => c.color[1])],
    B: [0, ...CLASSES.map((c) => c.color[2])],
    A: [0, 255, 255, 255, 255],
    I: [0, ...CLASSES.map((c) => c.id)],
    labels: ["", ...CLASSES.map((c) => `${c.shortLabel} — ${c.label}`)],
  };
}

/** LabelLegend rows and volumes (mL) for the four BLAST-CT TBI lesion classes. */
export function legendOf(summary) {
  const labels = CLASSES.map((c) => ({
    index: c.id,
    name: `${c.shortLabel} (${c.label})`,
    color: [...c.color, 255],
  }));
  const labelVolumes = Object.fromEntries(summary.classes.map((row) => [row.id, row.volumeMl]));
  return { labels, metrics: { labelVolumes } };
}
