// DOM-independent app logic: the settings and metadata the form gives, how a source is
// described, and the conversion report. Kept pure for test/config.test.js.
import automation from "../automation.json" with { type: "json" };
import { archiveBudget, conversionOptions, GENERATOR } from "@neurodesk/omezarr-convert/writer";
import { ZIP_MAX_ENTRIES } from "@neurodesk/omezarr-convert/zip";
import { isSpaceUnit, millimetresPer } from "@neurodesk/omezarr-convert/units";
import { ARRAY_TYPES } from "@neurodesk/omezarr-convert/pyramid";

export const APP = Object.freeze({
  id: "omezarr-convert",
  title: automation.title,
  version: "0.1.20261113",
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

/**
 * The largest store an archive may hold: the padded pyramid chunks at their worst case (no
 * compression). An archive is assembled in memory, and the README states the peak measured
 * at this size; a larger image goes to a folder.
 */
export const ARCHIVE_MAX_BYTES = 1024 ** 3;

/** Why the source cannot be converted to an archive with these settings, or null. */
export function archiveRefusal(source, settings) {
  const { bytes, entries } = archiveBudget(source.shape, source.dtype, settings);
  if (entries > ZIP_MAX_ENTRIES) return `The OME-Zarr would have ${entries} files; a zip holds at most ${ZIP_MAX_ENTRIES}. Save to a folder or choose larger chunks.`;
  if (bytes > ARCHIVE_MAX_BYTES) return `The OME-Zarr can reach ${formatGiB(bytes)} before compression; an archive is built in memory and holds at most ${formatGiB(ARCHIVE_MAX_BYTES)}. Save to a folder instead.`;
  return null;
}

const formatGiB = (bytes) => `${Number((bytes / 1024 ** 3).toPrecision(3))} GiB`;

/** The base name of the outputs: the input file's stem (a sequence's shared stem), made safe for file names. */
export function outputStem(source) {
  return String(source.stem ?? "").replace(/[\\/:*?"<>|]+/g, "_").trim() || "image";
}

export const NOTE_LINE_CHARACTERS = 90;

/**
 * The reader's notes as one visible line of at most 90 characters (their summaries, then
 * "+N more") and the full text for its tooltip. Null when there are none.
 */
export function noteLine(notes) {
  if (!notes.length) return null;
  const summaries = notes.map(({ summary }) => summary);
  let shown = summaries.length;
  const line = (count) => `${summaries.slice(0, count).join(" · ")}${count < summaries.length ? ` · +${summaries.length - count} more` : ""}`;
  while (shown > 1 && line(shown).length > NOTE_LINE_CHARACTERS) shown -= 1;
  return { text: line(shown).slice(0, NOTE_LINE_CHARACTERS), detail: notes.map(({ detail }) => detail).join(" ") };
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
export function conversionReport({ source, files, settings, written, seconds, attribution = null }) {
  return {
    generator: GENERATOR,
    input: { files, format: source.format, dtype: source.dtype, shape: source.shape, notes: source.notes.map(({ detail }) => detail), ...(attribution ? { attribution } : {}) },
    settings: { version: settings.version, method: settings.method, chunk: settings.chunk, compressionLevel: settings.compressionLevel },
    levels: written.plan.map(({ shape, chunks }, level) => ({ path: String(level), shape, chunks })),
    multiscales: written.multiscales,
    omero: written.omero,
    chunks: written.chunksWritten,
    bytes: written.bytesWritten,
    seconds: Number(seconds.toFixed(2)),
  };
}
