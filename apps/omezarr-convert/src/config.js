// DOM-independent app logic: the settings and metadata the form gives, how a source is
// described, and the conversion report. Kept pure for test/config.test.js.
import automation from "../automation.json" with { type: "json" };
import { conversionOptions, GENERATOR } from "@neurodesk/omezarr-convert/writer";
import { isSpaceUnit, millimetresPer } from "@neurodesk/omezarr-convert/units";
import { ARRAY_TYPES } from "@neurodesk/omezarr-convert/pyramid";

export const APP = Object.freeze({
  id: "omezarr-convert",
  title: automation.title,
  version: "0.0.20261105",
});

export const DISPLAY_UNITS = ["nanometer", "micrometer", "millimeter"];
const SYMBOLS = { nanometer: "nm", micrometer: "µm", millimeter: "mm" };

/** Conversion settings from the form or automation parameters, checked. */
export function formSettings({ version, method, chunk, compressionLevel, destination = "archive" }) {
  if (!["archive", "folder"].includes(destination)) throw new Error(`Unknown destination ${destination}.`);
  const options = conversionOptions({ version, method, chunk, compressionLevel });
  return { version: options.version, method: options.method, chunk: options.chunk, compressionLevel: options.compressionLevel, destination };
}

const round = (value) => Number(value.toPrecision(12));

/**
 * The voxel size shown in the form: the file's X, Y and Z in one unit (X's when it is nm, µm
 * or mm, else µm); `complete` is false when an axis has no length unit.
 */
export function displayUnit(source) {
  const name = DISPLAY_UNITS.includes(source.units.x) ? source.units.x : "micrometer";
  const values = {};
  let complete = true;
  for (const axis of ["x", "y", "z"]) {
    const unit = source.units[axis];
    if (source.scale[axis] && isSpaceUnit(unit ?? "")) values[axis] = round((source.scale[axis] * millimetresPer(unit)) / millimetresPer(name));
    else complete = false;
  }
  return { name, values, complete };
}

/**
 * What the form changes in the source's metadata. Voxel sizes replace the file's only when the
 * user edited them, all three then being required; channel names always apply where given.
 */
export function metadataOverrides({ edited, sizes, unit, labels }) {
  const overrides = { labels };
  if (!edited) return overrides;
  const values = Object.fromEntries(Object.entries(sizes).map(([axis, text]) => [axis, String(text).trim() === "" ? NaN : Number(text)]));
  if (Object.values(values).every(Number.isNaN)) return overrides;
  for (const axis of ["x", "y", "z"]) {
    if (!(Number.isFinite(values[axis]) && values[axis] > 0)) {
      const error = new Error(`Give the ${axis.toUpperCase()} voxel size as a positive number, or clear all three.`);
      error.field = "metadata";
      throw error;
    }
  }
  return { ...overrides, scale: values, unit };
}

/** Bytes of the source's pixels. */
export function rawBytes({ shape, dtype }) {
  return shape.t * shape.c * shape.z * shape.y * shape.x * ARRAY_TYPES[dtype].BYTES_PER_ELEMENT;
}

const size = (value, unit) => `${Number(value.toPrecision(4))} ${SYMBOLS[unit] ?? unit ?? ""}`.trim();

/** The one-line description under the input menu. */
export function describeSource(source, files) {
  const { t, c, z, y, x } = source.shape;
  const name = files.length === 1 ? files[0].name : `${files.length} files`;
  const dims = `${c} ch × ${z} × ${y} × ${x}${t > 1 ? ` × ${t} t` : ""}`;
  const voxel = source.scale.x && source.units.x ? ` · ${size(source.scale.x, source.units.x)}` : "";
  return `${name} · ${dims} · ${source.dtype}${voxel}`;
}

/** The JSON report downloaded with each conversion. */
export function conversionReport({ source, files, settings, written, seconds }) {
  return {
    generator: GENERATOR,
    input: { files, format: source.format, dtype: source.dtype, shape: source.shape, notes: source.notes },
    settings: { version: settings.version, method: settings.method, chunk: settings.chunk, compressionLevel: settings.compressionLevel },
    levels: written.plan.map(({ shape, chunks }, level) => ({ path: String(level), shape, chunks })),
    multiscales: written.multiscales,
    omero: written.omero,
    chunks: written.chunksWritten,
    bytes: written.bytesWritten,
    seconds: Number(seconds.toFixed(2)),
  };
}
