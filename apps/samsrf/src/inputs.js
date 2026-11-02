// The input slots of a SamSrf session and how a dropped file finds its slot.
// Pure: no DOM, so the rules are unit-tested under Node.

/** @typedef {'white' | 'pial' | 'inflated' | 'sphere' | 'mesh' | 'curv' | 'area'} SurfaceRole */
/** @typedef {'runs' | 'apertures' | 'roi' | 'surfaces' | 'template' | 'seed' | 'model'} Slot */

/**
 * @typedef {{
 *   runs: File[],
 *   apertures: File | null,
 *   roi: File | null,
 *   surfaces: Partial<Record<SurfaceRole, File>>,
 *   template: File | null,
 *   seed: File | null,
 * }} Inputs
 */

/** @returns {Inputs} */
export function emptyInputs() {
  return { runs: [], apertures: null, roi: null, surfaces: {}, template: null, seed: null };
}

const FREESURFER_SURFACE = /(?:^|[._-])(white|pial|inflated|sphere|orig|smoothwm|midthickness)(?:\.surf)?(?:\.gii)?$/i;
const MESH_GII = /\.surf\.gii$|(?:white|pial|inflated|sphere|midthickness)[^/]*\.gii$/i;

/**
 * Where a file belongs, judged by its name the way SamSrf's own folders are laid
 * out: runs and templates are GIfTI data, surfaces are FreeSurfer files or GIfTI
 * meshes, labels are the ROI unless their name says seed.
 * @returns {{ slot: Slot, role?: SurfaceRole } | null}
 */
export function classifyFile(name) {
  const base = name.split("/").pop();
  if (/\.label$/i.test(base)) return { slot: /seed/i.test(base) ? "seed" : "roi" };
  if (/\.(mat|gif)$|\.nii(\.gz)?$/i.test(base)) return { slot: "apertures" };
  if (/\.json$/i.test(base)) return { slot: "model" };
  if (/\.(curv|sulc)$/i.test(base)) return { slot: "surfaces", role: "curv" };
  if (/\.area$/i.test(base)) return { slot: "surfaces", role: "area" };
  if (/\.gii$/i.test(base)) {
    if (MESH_GII.test(base)) return { slot: "surfaces", role: surfaceRole(base) ?? "mesh" };
    if (/benson|template|atlas/i.test(base)) return { slot: "template" };
    return { slot: "runs" };
  }
  const surface = surfaceRole(base);
  if (surface) return { slot: "surfaces", role: surface };
  return null;
}

function surfaceRole(base) {
  const match = FREESURFER_SURFACE.exec(base);
  if (!match) return null;
  const kind = match[1].toLowerCase();
  return ["white", "pial", "inflated", "sphere"].includes(kind) ? kind : "mesh";
}

/**
 * Sort files into slots. Returns the slots they fill and the names nothing took.
 * Runs keep the order of their names (lh_uBars1 … lh_uBars6), as a shell glob would.
 */
export function sortFiles(files) {
  /** @type {Partial<Inputs> & { model?: File }} */
  const filled = {};
  const ignored = [];
  for (const file of files) {
    const target = classifyFile(file.webkitRelativePath || file.name);
    if (!target) {
      ignored.push(file.name);
    } else if (target.slot === "runs") {
      (filled.runs ??= []).push(file);
    } else if (target.slot === "surfaces") {
      (filled.surfaces ??= {})[target.role] = file;
    } else {
      filled[target.slot] = file;
    }
  }
  filled.runs?.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return { filled, ignored };
}

/** Put sorted files into a session: filled slots are replaced, the rest kept. */
export function mergeInputs(inputs, filled) {
  return {
    ...inputs,
    ...Object.fromEntries(Object.entries(filled).filter(([slot]) => slot !== "model" && slot !== "surfaces")),
    surfaces: { ...inputs.surfaces, ...filled.surfaces },
  };
}

/** What a mesh is drawn on: the inflated surface when there is one. */
export function displaySurface(surfaces) {
  return surfaces.inflated ?? surfaces.mesh ?? surfaces.white ?? surfaces.pial ?? surfaces.sphere ?? null;
}

/**
 * The inputs an analysis still lacks, as the words shown on the Run button's hint.
 * @param {import('./models.js').Analysis} analysis
 */
export function missingInputs(analysis, model, inputs) {
  const missing = [];
  if (!inputs.runs.length) missing.push("runs");
  if (analysis === "cf") {
    if (!inputs.template) missing.push("a template map");
    if (!inputs.seed) missing.push("a seed label");
    if (!inputs.surfaces.area) missing.push("a surface area file");
    if (Number(model.Smoothing) > 0 && !inputs.surfaces.white) missing.push("a white surface");
  } else if (!inputs.apertures) {
    missing.push("apertures");
  }
  return missing;
}

/** One line per slot for the log and the field text. */
export function describeSurfaces(surfaces) {
  return Object.values(surfaces).map((file) => file.name).join(", ");
}
