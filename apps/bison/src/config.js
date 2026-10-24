// DOM-independent app config and the rules the page applies before and after a run. Kept pure
// so it can be unit-tested under Node without a browser (see test/config.test.js).
export const APP = Object.freeze({
  id: "bison",
  title: "BISON tissue segmentation",
});

// Set from the measured largest stage heap.
export const MIN_DEVICE_MEMORY_GB = 8;

// The status line holds one short sentence; the full message goes to the technical log.
export const STATUS_MAX_CHARS = 90;

/** The refusal for a device that reports less memory than a run needs; null when it may run. */
export function memoryRefusal(deviceMemory, minimum = MIN_DEVICE_MEMORY_GB) {
  if (typeof deviceMemory !== "number" || !Number.isFinite(deviceMemory)) return null;
  if (deviceMemory >= minimum) return null;
  return `This device reports ${deviceMemory} GB of memory. BISON needs ${minimum} GB or more.`;
}

/** The mode the inputs give: 't1' (BISON) or 't1-flair' (BISON-WMH); null without a T1. */
export function inputMode({ t1, flair }) {
  if (!t1) return null;
  return flair ? "t1-flair" : "t1";
}

export const MODE_HINTS = Object.freeze({
  t1: "BISON: 8 tissue classes from the T1. Add a FLAIR to also find WMH.",
  "t1-flair": "BISON-WMH: 9 classes from the T1 and FLAIR, with WMH.",
});

export function modeHint(mode) {
  return MODE_HINTS[mode] ?? "Load a T1 image. A FLAIR is optional.";
}

// Label k of the label map is class k; label 0 is background. Colours follow FreeSurfer's
// lookup table where it has the structure.
export const CLASSES = Object.freeze([
  { label: 1, slug: "ventricles", name: "Ventricles", color: [120, 18, 134] },
  { label: 2, slug: "csf", name: "CSF", color: [80, 160, 255] },
  { label: 3, slug: "cerebellar-gm", name: "Cerebellar GM", color: [230, 148, 34] },
  { label: 4, slug: "cerebellar-wm", name: "Cerebellar WM", color: [220, 248, 164] },
  { label: 5, slug: "brainstem", name: "Brainstem", color: [119, 159, 176] },
  { label: 6, slug: "deep-gm", name: "Deep GM", color: [0, 118, 14] },
  { label: 7, slug: "cortical-gm", name: "Cortical GM", color: [205, 62, 78] },
  { label: 8, slug: "wm", name: "WM", color: [245, 245, 245] },
  { label: 9, slug: "wmh", name: "WMH", color: [255, 215, 0] },
].map((entry) => Object.freeze(entry)));

export function classesFor(mode) {
  return CLASSES.slice(0, mode === "t1-flair" ? 9 : 8);
}

/** NiiVue's label colour map for the label map of a mode, background transparent. */
export function labelColormap(mode) {
  const classes = classesFor(mode);
  return {
    R: [0, ...classes.map(({ color }) => color[0])],
    G: [0, ...classes.map(({ color }) => color[1])],
    B: [0, ...classes.map(({ color }) => color[2])],
    A: [0, ...classes.map(() => 255)],
    I: [0, ...classes.map(({ label }) => label)],
    labels: ["", ...classes.map(({ name }) => name)],
  };
}

/** The legend rows of LabelLegend: one per class, with the volumes of a run in labelVolumes. */
export function legendOf(mode, volumes = []) {
  const labels = classesFor(mode).map(({ label, name, color }) => ({ index: label, name, color: [...color, 255] }));
  const labelVolumes = Object.fromEntries(volumes.map(({ label, ml }) => [label, ml]));
  return { labels, metrics: { labelVolumes } };
}

// Where each stage starts, as a part of the whole run. From a 1 mm T1 + FLAIR run in Node on
// 8 threads: the affine registration takes about 16 % and the SyN registration about 72 %.
const STAGES = [
  ["Registering T1 to the template (affine)", 0.04],
  ["Denoising T1", 0.2],
  ["Correcting T1 intensity non-uniformity", 0.23],
  ["Normalising T1 intensities", 0.24],
  ["Registering T1 to the template (affine + SyN)", 0.25],
  ["Resampling", 0.9],
  ["Registering FLAIR to T1 (rigid)", 0.92],
  ["Denoising FLAIR", 0.94],
  ["Correcting FLAIR intensity non-uniformity", 0.95],
  ["Normalising FLAIR intensities", 0.955],
  ["Classifying tissues", 0.96],
  ["Writing results", 0.99],
];

// Downloads of the model files fill the part before the first stage.
export const DOWNLOAD_SHARE = 0.04;
const CLASSIFY = [0.96, 0.99];

/** The run fraction where the stage named by a progress message starts; null for another message. */
export function stageFraction(message) {
  const stage = STAGES.find(([prefix]) => message === prefix || message.startsWith(`${prefix} `));
  return stage ? stage[1] : null;
}

/** The run fraction when the classifier has done `fraction` of its voxels. */
export function classifyFraction(fraction) {
  return CLASSIFY[0] + (CLASSIFY[1] - CLASSIFY[0]) * Math.min(1, Math.max(0, fraction));
}

/** A message cut to its first sentence, or to STATUS_MAX_CHARS, for the status line. */
export function statusLine(message, limit = STATUS_MAX_CHARS) {
  if (message.length <= limit) return message;
  const first = message.match(/^.*?[.;](?=\s)/)?.[0];
  return first && first.length <= limit ? first : `${message.slice(0, limit - 2).trimEnd()}…`;
}

/** The held-asset base URL from the build's VITE_BISON_ASSET_BASE, absolute; null when unset. */
export function heldBaseUrl(value, origin) {
  if (!value) return null;
  const url = new URL(value, origin);
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url.href;
}

const OUTPUT = /_bison-(labels|mask|prob-([a-z-]+))\.nii\.gz$/;

/**
 * The Output rows of the files a run returns, keyed for createResultList: the label map, one
 * probability map per class and the classification mask. Unknown names are refused.
 */
export function resultRows(files) {
  const rows = {};
  const probabilities = {};
  for (const file of files) {
    const match = OUTPUT.exec(file.name);
    if (!match) throw new Error(`BISON returned an unexpected file, ${file.name}.`);
    if (match[1] === "labels") rows.labels = { kind: "labels", description: "Tissue labels", file };
    else if (match[1] === "mask") rows.mask = { kind: "mask", description: "Classification mask", file };
    else {
      const entry = CLASSES.find(({ slug }) => slug === match[2]);
      if (!entry) throw new Error(`BISON returned an unexpected file, ${file.name}.`);
      probabilities[`prob-${entry.slug}`] = { kind: "probability", description: `${entry.name} probability`, file };
    }
  }
  if (!rows.labels || !rows.mask) throw new Error("BISON returned no label map or mask.");
  return { labels: rows.labels, ...probabilities, mask: rows.mask };
}

/** One analysis line per class: name and volume in mL. */
export function volumeLines(volumes) {
  return volumes.map(({ label, ml }) => `${CLASSES[label - 1]?.name ?? `Label ${label}`}: ${ml.toFixed(2)} mL`);
}
