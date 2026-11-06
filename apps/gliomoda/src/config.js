// DOM-independent app config. Kept pure so it can be unit-tested under Node
// without a browser (see test/config.test.js).
import { LABELS } from "@neurodesk/gliomoda/results";

export const APP = Object.freeze({
  id: "gliomoda",
  title: "GlioMODA",
});

// GlioMODA's sequence order, with the names the sidebar shows.
export const SEQUENCES = Object.freeze([
  Object.freeze({ role: "t1c", label: "T1c", name: "T1 contrast-enhanced" }),
  Object.freeze({ role: "t2f", label: "FLAIR", name: "T2 FLAIR" }),
  Object.freeze({ role: "t1n", label: "T1", name: "T1 native" }),
  Object.freeze({ role: "t2w", label: "T2", name: "T2-weighted" }),
]);

// Filename tokens per sequence, checked in this order so t1c/t1ce/t1gd win over t1 and flair
// over t2. A token must stand alone between separators or at either end of the stem.
const TOKENS = [
  ["t1c", ["t1c", "t1ce", "t1gd", "t1post", "t1-post", "t1_post", "t1contrast", "ce-t1", "cet1", "t1w-ce", "postcontrast"]],
  ["t2f", ["t2f", "flair", "fla", "t2flair", "t2-flair", "t2_flair"]],
  ["t1n", ["t1n", "t1", "t1w", "t1native", "t1pre", "t1-pre", "t1_pre", "native"]],
  ["t2w", ["t2w", "t2"]],
];

const stem = (name) => name.toLowerCase().replace(/\.nii(\.gz)?$/, "");

/** The sequence a file name states, or null when it states none. */
export function sequenceFromName(name) {
  const text = stem(name);
  // A BIDS T1w with a contrast-agent entity (ce-gadolinium) is the contrast-enhanced T1.
  if (/(^|_)ce-[a-z0-9]+_/.test(text) && /_t1w$/.test(text)) return "t1c";
  for (const [role, tokens] of TOKENS) {
    for (const token of tokens) {
      const escaped = token.replace(/[-_]/g, "[-_]");
      if (new RegExp(`(^|[-_.\\s])${escaped}($|[-_.\\s])`).test(text)) return role;
    }
  }
  return null;
}

/**
 * Sequence → file name for a set of files: each file takes the sequence its name states, and the
 * rest fill the free sequences in GlioMODA's order. Refuses more than four files and two files
 * naming one sequence.
 */
export function assignSequences(names) {
  if (names.length > SEQUENCES.length) throw new Error("Choose at most four images: T1c, FLAIR, T1 and T2.");
  const assigned = {};
  const unnamed = [];
  for (const name of names) {
    const role = sequenceFromName(name);
    if (!role) {
      unnamed.push(name);
      continue;
    }
    if (assigned[role]) throw new Error(`${assigned[role]} and ${name} are both ${SEQUENCES.find((s) => s.role === role).label} images.`);
    assigned[role] = name;
  }
  for (const { role } of SEQUENCES) {
    if (!assigned[role] && unnamed.length) assigned[role] = unnamed.shift();
  }
  return assigned;
}

// The model for the assigned sequences, from the ids the manifest ships. GlioMODA has one plain
// model per combination it was trained on (not T1 alone, T1 + T2, T1c + FLAIR + T1 or
// T1c + FLAIR + T2), and the ResEncL model for all four.
export function modelChoice(roles, available, { resEncL = false } = {}) {
  const chosen = SEQUENCES.filter(({ role }) => roles.includes(role));
  if (!chosen.length) return { id: null, hint: "Load at least one of T1c, FLAIR, T1 or T2." };
  const mode = chosen.map(({ role }) => role).join("-");
  const names = chosen.map(({ label }) => label).join(" + ");
  if (!available.includes(mode)) return { id: null, hint: `GlioMODA has no ${names} model. Add or remove a sequence.` };
  const id = resEncL && available.includes(`${mode}_ResEncL`) ? `${mode}_ResEncL` : mode;
  return { id, hint: `Model: ${names}${id === mode ? "" : " (ResEncL)"}` };
}

// Colours of the BraTS labels, as the BraTS challenge figures draw them.
export const LABEL_COLORS = Object.freeze({ 1: [255, 64, 64], 2: [64, 200, 64], 3: [255, 220, 0] });

/** NiiVue's label colour map, background transparent. */
export function labelColormap() {
  return {
    R: [0, ...LABELS.map(({ value }) => LABEL_COLORS[value][0])],
    G: [0, ...LABELS.map(({ value }) => LABEL_COLORS[value][1])],
    B: [0, ...LABELS.map(({ value }) => LABEL_COLORS[value][2])],
    A: [0, 255, 255, 255],
    I: [0, ...LABELS.map(({ value }) => value)],
    labels: ["", ...LABELS.map(({ name }) => name)],
  };
}

/** LabelLegend rows with the run's volumes. */
export function legendOf(rows) {
  const labels = LABELS.map(({ value, name }) => ({ index: value, name, color: [...LABEL_COLORS[value], 255] }));
  const labelVolumes = Object.fromEntries(rows.filter(({ id }) => /^\d$/.test(id)).map(({ id, ml }) => [Number(id), ml]));
  return { labels, metrics: { labelVolumes } };
}
