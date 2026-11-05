// Tables the app downloads. Pure: analyses in, CSV text out. Lengths are in the SWC's
// units (µm by convention), areas in µm², volumes in µm³ and angles in degrees.
import { NEURITE_TYPES } from "./morphometrics.js";

const DEGREES = 180 / Math.PI;
const TYPE_NAME = { 2: "axon", 3: "basal", 4: "apical" };

const number = (value) => (Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(10))));
/** The mean angle in degrees, or null without bifurcations. */
const meanDegrees = (values) => (values.length ? (values.reduce((sum, value) => sum + value, 0) / values.length) * DEGREES : null);
const field = (value) => (value == null ? "" : typeof value === "number" ? number(value) : /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value);
const csv = (rows) => `${rows.map((row) => row.map(field).join(",")).join("\n")}\n`;

/** The morphometrics rows of one neuron: one per neurite type, "all" first. */
export const MORPHOMETRIC_COLUMNS = Object.freeze([
  ["neurites", "neurites", (f) => f.neurites],
  ["sections", "sections", (f) => f.sections],
  ["bifurcations", "bifurcations", (f) => f.bifurcations],
  ["forking_points", "forking points", (f) => f.forkingPoints],
  ["terminals", "terminal points", (f) => f.terminals],
  ["total_length_um", "total length (µm)", (f) => f.totalLength],
  ["surface_area_um2", "surface area (µm²)", (f) => f.surfaceArea],
  ["volume_um3", "volume (µm³)", (f) => f.volume],
  ["max_path_distance_um", "max path distance (µm)", (f) => f.maxPathDistance],
  ["max_radial_distance_um", "max radial distance (µm)", (f) => f.maxRadialDistance],
  ["max_branch_order", "max branch order", (f) => f.maxBranchOrder],
  ["max_strahler_order", "max Strahler order", (f) => f.maxStrahlerOrder],
  ["mean_local_bifurcation_angle_deg", "mean local bifurcation angle (°)", (f) => meanDegrees(f.localBifurcationAngles)],
  ["mean_remote_bifurcation_angle_deg", "mean remote bifurcation angle (°)", (f) => meanDegrees(f.remoteBifurcationAngles)],
]);

/** @param {{ name: string, analysis: ReturnType<typeof import("./morphometrics.js").analyse> }[]} neurons */
export function morphometricsCsv(neurons) {
  const rows = [["neuron", "neurite_type", ...MORPHOMETRIC_COLUMNS.map(([key]) => key)]];
  for (const { name, analysis } of neurons) {
    for (const type of Object.keys(NEURITE_TYPES)) {
      const features = analysis.features[type];
      if (type !== "all" && !features.neurites) continue;
      rows.push([name, type, ...MORPHOMETRIC_COLUMNS.map(([, , get]) => get(features))]);
    }
  }
  return csv(rows);
}

/** Sholl intersections, one row per neuron and radius, a column per neurite type. */
export function shollCsv(neurons) {
  const types = Object.keys(NEURITE_TYPES);
  const rows = [["neuron", "radius_um", ...types.map((type) => `${type}_intersections`)]];
  for (const { name, analysis } of neurons) {
    const { radii, crossings } = analysis.sholl;
    radii.forEach((radius, k) => rows.push([name, radius, ...types.map((type) => crossings[type][k])]));
  }
  return csv(rows);
}

/** One row per bifurcation (exactly two children). */
export function bifurcationsCsv(neurons) {
  const rows = [["neuron", "neurite_type", "branch_order", "path_distance_um", "radial_distance_um", "local_angle_deg", "remote_angle_deg"]];
  for (const { name, analysis } of neurons) {
    for (const record of analysis.features.all.bifurcationRecords) {
      rows.push([name, TYPE_NAME[record.neuriteType] ?? `type ${record.neuriteType}`, record.branchOrder, record.pathDistance, record.radialDistance, record.local * DEGREES, record.remote * DEGREES]);
    }
  }
  return csv(rows);
}

/** A short summary of one neuron for the report, the log and automation. */
export function summary(analysis) {
  const all = analysis.features.all;
  return {
    neurites: all.neurites,
    totalLengthUm: all.totalLength,
    bifurcations: all.bifurcations,
    terminals: all.terminals,
    maxPathDistanceUm: all.maxPathDistance,
    maxBranchOrder: all.maxBranchOrder,
    maxStrahlerOrder: all.maxStrahlerOrder,
    surfaceAreaUm2: all.surfaceArea,
    volumeUm3: all.volume,
    peakShollIntersections: Math.max(0, ...analysis.sholl.crossings.all),
  };
}
