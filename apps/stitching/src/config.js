// DOM-independent app config and settings. Kept pure so it can be unit-tested under Node
// without a browser (see test/config.test.js).
import automation from "../automation.json" with { type: "json" };
import { GLOBAL_DEFAULTS } from "./core/global.js";
import { GRID_STARTS, GRID_TYPES } from "./core/tile-layout.js";
import { PAIRWISE_DEFAULTS } from "./core/pairwise.js";

export const APP = Object.freeze({
  id: "stitching",
  title: automation.title,
  version: "0.2.20261113",
});

export const LAYOUTS = Object.freeze({
  grid: "Grid",
  file: "TileConfiguration file",
  stage: "OME stage positions",
});

/** Decoded tiles above this many bytes in total are refused before decoding. */
export const MAX_TILE_BYTES = 1.5e9;
/**
 * Fused images above this many pixels are refused. The sum and weight buffers take 4 bytes each
 * per pixel (Float32) for 8- and 16-bit tiles and 8 bytes each (Float64) for 32- and 64-bit
 * tiles; src/core/memory.js checks the whole fusion against the working-memory budget.
 */
export const MAX_FUSED_PIXELS = 150e6;

export class SettingsError extends Error {
  constructor(field, message) {
    super(message);
    this.name = "SettingsError";
    this.field = field;
  }
}

function number(values, field, label, { min = -Infinity, max = Infinity, integer = false } = {}) {
  const raw = values[field];
  const value = typeof raw === "number" ? raw : Number(String(raw ?? "").trim());
  if (String(raw ?? "").trim() === "" || !Number.isFinite(value)) throw new SettingsError(field, `${label} must be a number.`);
  if (integer && !Number.isInteger(value)) throw new SettingsError(field, `${label} must be a whole number.`);
  if (value < min || value > max) throw new SettingsError(field, `${label} must be between ${min} and ${max}.`);
  return value;
}

function choice(values, field, label, options) {
  const value = String(values[field] ?? "");
  if (!Object.hasOwn(options, value)) throw new SettingsError(field, `${label} must be one of ${Object.keys(options).join(", ")}.`);
  return value;
}

/**
 * Settings from form values (strings) or automation parameters. The grid fields are read only
 * for the grid layout, so a file or stage layout runs whatever the grid fields hold.
 */
export function readSettings(values) {
  const layout = choice(values, "layout", "Layout", LAYOUTS);
  const settings = {
    layout,
    pairwise: {
      peaks: number(values, "peaks", "Peaks to check", { min: 1, max: 20, integer: true }),
      minOverlap: PAIRWISE_DEFAULTS.minOverlap,
    },
    global: {
      threshold: number(values, "threshold", "Correlation threshold", { min: 0, max: 1 }),
      maxRatio: number(values, "maxRatio", "Max/mean residual", { min: 1, max: 100 }),
      maxAbsolute: number(values, "maxAbsolute", "Mean residual limit", { min: 0, max: 10000 }),
    },
  };
  if (layout === "grid") {
    settings.grid = {
      columns: number(values, "columns", "Columns", { min: 1, max: 1000, integer: true }),
      rows: number(values, "rows", "Rows", { min: 1, max: 1000, integer: true }),
      overlap: number(values, "overlap", "Tile overlap", { min: 0, max: 95 }) / 100,
      type: choice(values, "gridType", "Grid type", GRID_TYPES),
      start: choice(values, "gridStart", "First tile", GRID_STARTS),
    };
  }
  return settings;
}

export const DEFAULT_VALUES = Object.freeze({
  layout: "grid",
  columns: 2,
  rows: 2,
  overlap: 10,
  gridType: "row",
  gridStart: "top-left",
  peaks: PAIRWISE_DEFAULTS.peaks,
  threshold: GLOBAL_DEFAULTS.threshold,
  maxRatio: GLOBAL_DEFAULTS.maxRatio,
  maxAbsolute: GLOBAL_DEFAULTS.maxAbsolute,
});

/** Columns and rows for `count` tiles when the user has not said: the most square factorisation. */
export function guessGrid(count) {
  let columns = Math.ceil(Math.sqrt(count));
  while (columns > 1 && count % columns) columns--;
  if (columns === 1 && count > 3) columns = Math.ceil(Math.sqrt(count));
  return { columns, rows: Math.ceil(count / columns) };
}
