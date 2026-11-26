// DOM-independent app config and profile SVG renderer for LayNii.
import automation from "../automation.json" with { type: "json" };
import packageJson from "../package.json" with { type: "json" };
import {
  MAX_VOXELS,
  layersArguments,
  profileArguments,
} from "@neurodesk/laynii";
import { LAYNII_UPSTREAM_VERSION, LAYNII_WASM_SHA256 } from "@neurodesk/laynii/pin";

export const APP = Object.freeze({
  id: "laynii",
  title: automation.title,
  version: packageJson.version,
  upstreamVersion: LAYNII_UPSTREAM_VERSION,
});

const params = automation.operations.layers.parameters;
export const SETTINGS = Object.freeze({
  nrLayers: Object.freeze({ min: params.nrLayers.minimum, max: params.nrLayers.maximum, default: params.nrLayers.default }),
  equivol: Object.freeze({ default: params.equivol.default }),
  iterSmooth: Object.freeze({ min: params.iterSmooth.minimum, max: params.iterSmooth.maximum, default: params.iterSmooth.default }),
  thickness: Object.freeze({ default: params.thickness.default }),
  curvature: Object.freeze({ default: params.curvature.default }),
  inclBorders: Object.freeze({ default: params.inclBorders.default }),
  equalCounts: Object.freeze({ default: params.equalCounts.default }),
  noSmooth: Object.freeze({ default: params.noSmooth.default }),
});

/** Normalize and validate form or automation settings. */
export function layniiSettings(values = {}) {
  const settings = {
    nrLayers: values.nrLayers ?? SETTINGS.nrLayers.default,
    equivol: Boolean(values.equivol ?? SETTINGS.equivol.default),
    iterSmooth: values.iterSmooth ?? SETTINGS.iterSmooth.default,
    thickness: Boolean(values.thickness ?? SETTINGS.thickness.default),
    curvature: Boolean(values.curvature ?? SETTINGS.curvature.default),
    inclBorders: Boolean(values.inclBorders ?? SETTINGS.inclBorders.default),
    equalCounts: Boolean(values.equalCounts ?? SETTINGS.equalCounts.default),
    noSmooth: Boolean(values.noSmooth ?? SETTINGS.noSmooth.default),
  };
  for (const [key, label] of [["nrLayers", "Number of layers"], ["iterSmooth", "Smoothing iterations"]]) {
    const { min, max } = SETTINGS[key];
    const value = settings[key];
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      throw new Error(`${label} must be a whole number from ${min} to ${max}.`);
    }
  }
  return settings;
}

/** Reject 4D volumes or volumes exceeding the WASM32 memory budget before allocation. */
export function volumeRefusal({ dimensionality, frames, dims }, label = "Image") {
  if (frames > 1) {
    return `${label} has ${frames} volumes. Choose a single 3D volume.`;
  }
  if (dimensionality !== 3) {
    return `${label} is ${dims.join(" × ")}, not a 3D volume. Choose a 3D image.`;
  }
  const voxels = dims[0] * dims[1] * dims[2];
  if (voxels > MAX_VOXELS) {
    return `${label} has ${(voxels / 1e6).toFixed(1)} million voxels (${dims.join(" × ")}), above the browser limit of ${Math.round(MAX_VOXELS / 1e6)} million voxels.`;
  }
  return null;
}

/** Human-readable label for a LayNii profile layer source. */
export function profileSourceLabel(source) {
  if (source === "equivol") return "equivolume";
  if (source === "equicount") return "equal-count";
  return "equidistant";
}

/** Strip .nii.gz or .nii to form LayNii-style output stems. */
export function stemName(filename) {
  return String(filename || "rim").replace(/\.nii(\.gz)?$/i, "");
}

export function outputFileName(rimName, suffix, ext = ".nii.gz") {
  return `${stemName(rimName)}_${suffix}${ext}`;
}

function shellArgument(value) {
  return /^[A-Za-z0-9_./=-]+$/.test(value) ? value : "'" + value.replaceAll("'", "'\\''") + "'";
}

/** Reproducible provenance and native LayNii CLI commands matching this browser run. */
export function provenance({ rimName, signalName = null, settings, profileSource = null }) {
  const layersArgv = layersArguments({ rim: rimName, output: `${stemName(rimName)}.nii.gz`, ...settings });
  const commands = [`LN2_LAYERS ${layersArgv.map(shellArgument).join(" ")}`];
  let profileArgv = null;
  if (signalName && profileSource) {
    const layerFile = outputFileName(rimName, `layers_${profileSource}`);
    const outTxt = `${stemName(signalName)}_profile.txt`;
    profileArgv = profileArguments({ input: signalName, layers: layerFile, output: outTxt });
    commands.push(`LN2_PROFILE ${profileArgv.map(shellArgument).join(" ")}`);
  }
  return {
    method: `LayNii v${LAYNII_UPSTREAM_VERSION} (LN2_LAYERS${signalName ? " + LN2_PROFILE" : ""})`,
    module: { package: "@neurodesk/laynii", wasmSha256: LAYNII_WASM_SHA256, threads: 1 },
    settings: { ...settings },
    rim: rimName,
    signal: signalName,
    profileSource,
    nativeCommands: commands,
    nativeCommand: commands.join(" && "),
  };
}

/** Render an accessible token-styled SVG laminar profile plot (mean +/- SD from WM to CSF), leaving gaps where voxels === 0. */
export function renderProfileSvg(rows) {
  if (!rows?.length) return "";
  const populated = rows
    .map((row, idx) => ({ row, idx }))
    .filter(({ row }) => row.voxels > 0 && Number.isFinite(row.mean) && Number.isFinite(row.std));
  if (!populated.length) return "";

  const width = 560;
  const height = 220;
  const pad = { left: 56, right: 20, top: 18, bottom: 34 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  let minY = Infinity;
  let maxY = -Infinity;
  for (const { row } of populated) {
    minY = Math.min(minY, row.mean - row.std, row.mean);
    maxY = Math.max(maxY, row.mean + row.std, row.mean);
  }
  if (!Number.isFinite(minY) || !Number.isFinite(maxY)) return "";
  if (maxY - minY < 1e-6) {
    minY -= 1;
    maxY += 1;
  } else {
    const margin = (maxY - minY) * 0.08;
    minY -= margin;
    maxY += margin;
  }

  const xAt = (idx) => (rows.length === 1 ? pad.left + plotW / 2 : pad.left + (idx / (rows.length - 1)) * plotW);
  const yAt = (val) => pad.top + (1 - (val - minY) / (maxY - minY)) * plotH;

  // Split into contiguous runs of non-empty layers so empty layers leave clean visual gaps.
  const runs = [];
  let currentRun = [];
  for (let idx = 0; idx < rows.length; idx++) {
    const row = rows[idx];
    if (row.voxels > 0 && Number.isFinite(row.mean) && Number.isFinite(row.std)) {
      currentRun.push({ row, idx });
    } else if (currentRun.length) {
      runs.push(currentRun);
      currentRun = [];
    }
  }
  if (currentRun.length) runs.push(currentRun);

  const bands = runs
    .filter((run) => run.length >= 2)
    .map((run) => {
      const upper = run.map(({ row, idx }) => `${xAt(idx).toFixed(1)},${yAt(row.mean + row.std).toFixed(1)}`);
      const lower = run.map(({ row, idx }) => `${xAt(idx).toFixed(1)},${yAt(row.mean - row.std).toFixed(1)}`).reverse();
      return `<polygon class="laynii-band" points="${[...upper, ...lower].join(" ")}"/>`;
    })
    .join("");

  const pathSegments = runs
    .filter((run) => run.length >= 2)
    .map((run) => run.map(({ row, idx }, j) => `${j === 0 ? "M" : "L"}${xAt(idx).toFixed(1)},${yAt(row.mean).toFixed(1)}`).join(" "))
    .join(" ");
  const lineEl = pathSegments ? `<path class="laynii-line" d="${pathSegments}"/>` : "";

  const points = populated
    .map(({ row, idx }) => `<circle class="laynii-point" cx="${xAt(idx).toFixed(1)}" cy="${yAt(row.mean).toFixed(1)}" r="3.5"><title>Layer ${row.layer}: ${row.mean.toFixed(4)} ± ${row.std.toFixed(4)} (n=${row.voxels})</title></circle>`)
    .join("");

  const fmt = (v) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(2) : v.toFixed(3));
  const yMid = (minY + maxY) / 2;

  return [
    `<svg class="laynii-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Laminar signal profile from inner WM layer 1 to outer CSF layer ${rows.length}">`,
    `<line class="laynii-axis" x1="${pad.left}" y1="${pad.top}" x2="${pad.left}" y2="${pad.top + plotH}"/>`,
    `<line class="laynii-axis" x1="${pad.left}" y1="${pad.top + plotH}" x2="${pad.left + plotW}" y2="${pad.top + plotH}"/>`,
    bands,
    lineEl,
    points,
    `<text class="laynii-label" x="${pad.left - 8}" y="${pad.top + 4}" text-anchor="end">${fmt(maxY)}</text>`,
    `<text class="laynii-label" x="${pad.left - 8}" y="${(pad.top + plotH / 2 + 4).toFixed(1)}" text-anchor="end">${fmt(yMid)}</text>`,
    `<text class="laynii-label" x="${pad.left - 8}" y="${pad.top + plotH + 4}" text-anchor="end">${fmt(minY)}</text>`,
    `<text class="laynii-label" x="${pad.left}" y="${height - 8}" text-anchor="start">Layer 1 (WM)</text>`,
    `<text class="laynii-label" x="${pad.left + plotW}" y="${height - 8}" text-anchor="end">Layer ${rows.length} (CSF)</text>`,
    `</svg>`,
  ].join("");
}
