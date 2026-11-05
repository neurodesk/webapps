// Output files of a stitching run that need no browser: the fused TIFF, Fiji's
// TileConfiguration.registered.txt, the link table and provenance. The OME-Zarr archive is
// written in ome-zarr.js (ngff-zarr runs only in the browser).
import { writeTiffStack } from "@neurodesk/webapp-components/file-io/tiff";
import { formatTileConfiguration } from "./core/tile-layout.js";

/** The common stem of the tile names (img_r001_c001.tif, … → img), or "mosaic". */
export function outputStem(names) {
  const stems = names.map((name) => name.replace(/\.ome\.tiff?$|\.tiff?$/i, ""));
  let prefix = stems[0] ?? "";
  for (const stem of stems) while (!stem.startsWith(prefix)) prefix = prefix.slice(0, -1);
  prefix = prefix.replace(/[_\-. ]*(?:r|c|x|y|z|tile|t|s)?\d*$/i, "").replace(/[_\-. ]+$/, "");
  return prefix || "mosaic";
}

/**
 * The ImageJ description for a fused 2D image or z stack. ImageJ reads `spacing` and `unit`;
 * a stack is described as slices so it opens as a volume.
 */
export function fusedDescription({ slices, pixelSize }) {
  const lines = ["ImageJ=1.11a", `images=${slices}`];
  if (slices > 1) lines.push(`slices=${slices}`);
  if (pixelSize?.x) lines.push("unit=micron");
  if (slices > 1 && pixelSize?.x && pixelSize?.z) lines.push(`spacing=${pixelSize.z}`);
  return `${lines.join("\n")}\n`;
}

/** The fused image as a baseline TIFF, one page per z plane, in the tiles' sample type. */
export function fusedTiff({ data, shape, pixelSize }) {
  const [width, height, slices = 1] = shape;
  const resolution = pixelSize?.x && pixelSize?.y ? { x: pixelSize.x, y: pixelSize.y } : null;
  return writeTiffStack({ width, height, data, description: fusedDescription({ slices, pixelSize }), pixelSize: resolution });
}

/** Fiji's TileConfiguration.registered.txt: every tile's registered position, in pixels. */
export function registeredConfiguration(names, positions) {
  return formatTileConfiguration(positions[0].length, names.map((name, k) => ({ name, position: positions[k] })));
}

const AXES = ["x", "y", "z"];

function decimal(value, digits = 4) {
  return Number(value.toFixed(digits)).toString();
}

/** One row per registered pair: layout and measured offsets, correlation, status, residual. */
export function linksCsv(names, links) {
  const dims = links[0]?.offset.length ?? 2;
  const axes = AXES.slice(0, dims);
  const header = ["tile_a", "tile_b", ...axes.map((a) => `layout_d${a}`), ...axes.map((a) => `measured_d${a}`), "correlation", "status", "residual_px"];
  const rows = links.map((link) => [
    names[link.i],
    names[link.j],
    ...link.approximateOffset.map((v) => decimal(v)),
    ...link.offset.map((v) => decimal(v)),
    decimal(link.r),
    link.status,
    decimal(link.residual),
  ]);
  return `${[header, ...rows].map((row) => row.join(",")).join("\n")}\n`;
}

/** Summary numbers of a run, for the log, the report and provenance. */
export function summarise(result) {
  const used = result.links.filter((link) => link.status === "used");
  const residuals = used.map((link) => link.residual);
  return {
    links: result.links.length,
    used: used.length,
    lowCorrelation: result.links.filter((link) => link.status === "low correlation").length,
    outliers: result.links.filter((link) => link.status === "outlier").length,
    unlinkedGroups: result.components.length - 1,
    meanResidual: residuals.length ? residuals.reduce((a, b) => a + b, 0) / residuals.length : 0,
    maxResidual: residuals.length ? Math.max(...residuals) : 0,
  };
}

export function provenance({ app, names, dims, dtype, pixelSize, settings, approximate, result, fused, timings }) {
  return {
    app: { id: app.id, version: app.version },
    method: {
      pairwise: "Phase correlation of the layout's overlap region, peaks checked by cross-correlation, sub-pixel by a parabola through the cross-correlation (after Preibisch, Saalfeld & Tomancak 2009)",
      global: "Correlation-weighted least squares of translations with iterative removal of the worst link",
      fusion: "Linear blending with linear interpolation at sub-pixel positions",
    },
    input: { tiles: names.length, dims, sampleType: dtype, pixelSizeMicrometres: pixelSize },
    settings,
    summary: summarise(result),
    tiles: names.map((name, k) => ({ name, layout: approximate[k], registered: result.positions[k] })),
    fused: { shape: fused.shape, originPixels: fused.origin },
    timings,
  };
}
