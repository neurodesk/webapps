// Approximate tile layouts: a regular grid entered by the user (Fiji's Grid/Collection
// stitching grid types), a Fiji TileConfiguration file, or the stage positions recorded in
// OME-TIFF files; and the Fiji TileConfiguration text the app writes back.

export const GRID_TYPES = Object.freeze({
  row: 'Row by row',
  column: 'Column by column',
  'snake-row': 'Snake by rows',
  'snake-column': 'Snake by columns',
});

export const GRID_STARTS = Object.freeze({
  'top-left': 'Top left',
  'top-right': 'Top right',
  'bottom-left': 'Bottom left',
  'bottom-right': 'Bottom right',
});

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/** Natural file-name order: img_2 before img_10. */
export function compareNames(a, b) {
  return collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
}

/** Grid cell (column, row) of the tile at `index` in acquisition order. */
export function gridCell(index, { columns, rows, type = 'row', start = 'top-left' }) {
  const byColumn = type === 'column' || type === 'snake-column';
  const snake = type.startsWith('snake-');
  const lineLength = byColumn ? rows : columns;
  const line = Math.floor(index / lineLength);
  let along = index % lineLength;
  if (snake && line % 2 === 1) along = lineLength - 1 - along;
  let column = byColumn ? line : along;
  let row = byColumn ? along : line;
  if (start.endsWith('right')) column = columns - 1 - column;
  if (start.startsWith('bottom')) row = rows - 1 - row;
  return { column, row };
}

/**
 * Approximate positions (pixels) of `count` tiles on a grid. The step between neighbours is
 * the tile size times (1 − overlap), truncated to whole pixels as Fiji writes it.
 * @param {{ count: number, columns: number, rows: number, overlap: number, type?: string, start?: string, shape: number[] }} grid
 *   overlap is a fraction (0.2 for 20 %); shape is the first tile's [nx, ny(, nz)].
 */
export function gridPositions({ count, columns, rows, overlap, type = 'row', start = 'top-left', shape }) {
  if (!Number.isInteger(columns) || !Number.isInteger(rows) || columns < 1 || rows < 1) throw new Error('The grid needs at least one column and one row.');
  if (count !== columns * rows) throw new Error(`A ${columns} × ${rows} grid holds ${columns * rows} tiles, but ${count} are loaded.`);
  if (!(overlap >= 0 && overlap < 1)) throw new Error('Tile overlap must be at least 0 % and below 100 %.');
  if (!GRID_TYPES[type]) throw new Error(`Unknown grid type ${type}.`);
  if (!GRID_STARTS[start]) throw new Error(`Unknown first tile ${start}.`);
  const stepX = Math.trunc(shape[0] * (1 - overlap));
  const stepY = Math.trunc(shape[1] * (1 - overlap));
  return Array.from({ length: count }, (_, index) => {
    const { column, row } = gridCell(index, { columns, rows, type, start });
    const position = [column * stepX, row * stepY];
    if (shape.length > 2) position.push(0);
    return position;
  });
}

function baseName(name) {
  return String(name).split(/[\\/]/).pop();
}

/**
 * Parses a Fiji TileConfiguration file (`dim = N` and `file; series; (x, y[, z])` lines).
 * @returns {{ dims: number, entries: { name: string, position: number[] }[] }}
 */
export function parseTileConfiguration(text) {
  let dims = null;
  const entries = [];
  const lines = String(text).split(/\r?\n/);
  lines.forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const dim = line.match(/^dim\s*=\s*(\d+)$/i);
    if (dim) {
      dims = Number(dim[1]);
      if (dims !== 2 && dims !== 3) throw new Error(`TileConfiguration line ${index + 1}: only 2D and 3D layouts are supported.`);
      return;
    }
    const entry = line.match(/^(.+?)\s*;\s*([^;]*?)\s*;\s*\(([^)]*)\)\s*$/);
    if (!entry) throw new Error(`TileConfiguration line ${index + 1} is not "file; ; (x, y)": ${line.slice(0, 80)}`);
    const [, name, series, coordinates] = entry;
    if (series) throw new Error(`TileConfiguration line ${index + 1} names series ${series}; multi-series files are not supported.`);
    const position = coordinates.split(',').map((v) => Number(v.trim()));
    if (position.some((v) => !Number.isFinite(v))) throw new Error(`TileConfiguration line ${index + 1} has a coordinate that is not a number.`);
    entries.push({ name: baseName(name), position });
  });
  if (!entries.length) throw new Error('The TileConfiguration file lists no tiles.');
  dims ??= entries[0].position.length;
  for (const { name, position } of entries) {
    if (position.length !== dims) throw new Error(`TileConfiguration entry ${name} has ${position.length} coordinates, not ${dims}.`);
  }
  const names = new Set();
  for (const { name } of entries) {
    if (names.has(name)) throw new Error(`TileConfiguration lists ${name} twice.`);
    names.add(name);
  }
  return { dims, entries };
}

/** Fiji's TileConfiguration text for `entries` ({ name, position }). */
export function formatTileConfiguration(dims, entries) {
  const lines = [
    '# Define the number of dimensions we are working on',
    `dim = ${dims}`,
    '',
    '# Define the image coordinates',
    ...entries.map(({ name, position }) => `${name}; ; (${position.map(formatCoordinate).join(', ')})`),
  ];
  return `${lines.join('\n')}\n`;
}

function formatCoordinate(value) {
  const rounded = Math.abs(value) < 1e-9 ? 0 : value;
  return Number.isInteger(rounded) ? rounded.toFixed(1) : String(rounded);
}

/** Positions for `names` (tile order) from a parsed TileConfiguration. */
export function positionsFromConfiguration(configuration, names, dims) {
  if (configuration.dims !== dims) throw new Error(`The TileConfiguration is ${configuration.dims}D but the tiles are ${dims}D.`);
  const byName = new Map(configuration.entries.map((entry) => [entry.name, entry.position]));
  const missing = names.filter((name) => !byName.has(name));
  if (missing.length) throw new Error(`The TileConfiguration does not list ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ` and ${missing.length - 3} more` : ''}.`);
  const extra = configuration.entries.filter((entry) => !names.includes(entry.name));
  if (extra.length) throw new Error(`The TileConfiguration lists ${extra[0].name}, which is not loaded.`);
  return names.map((name) => [...byName.get(name)]);
}

/** Translation-only stitching requires one sampling grid; allow 1 ppm metadata rounding. */
export function checkPixelSizes(pixelSizes, dims) {
  const axes = ['x', 'y', 'z'].slice(0, dims);
  const common = pixelSizes[0] ?? {};
  for (const [index, size] of pixelSizes.entries()) {
    for (const axis of axes) {
      const value = size?.[axis];
      const expected = common[axis];
      if (value == null && expected == null) continue;
      if (!(Number.isFinite(value) && value > 0 && Number.isFinite(expected) && expected > 0)
        || Math.abs(value - expected) > expected * 1e-6) {
        throw new Error(`Tile ${index + 1} has incompatible ${axis} pixel spacing. Stitch tiles with the same calibration.`);
      }
    }
  }
  return common;
}

/**
 * Positions (pixels) from OME stage positions (micrometres) and pixel sizes (micrometres),
 * relative to the smallest stage position. Stage axes are assumed to run with the image axes.
 */
export function positionsFromStage(stages, pixelSizes, dims) {
  const missing = stages.findIndex((stage) => !stage || !Number.isFinite(stage.x) || !Number.isFinite(stage.y));
  if (missing >= 0) throw new Error(`Tile ${missing + 1} has no OME stage position.`);
  const sizes = pixelSizes.map((size) => size ?? {});
  if (sizes.some((size) => !(size.x > 0 && size.y > 0))) throw new Error('Stage positions need the pixel size of every tile.');
  if (dims > 2 && sizes.some((size) => !(size.z > 0))) throw new Error('3D stage positions need the z spacing of every tile.');
  // Stacks are placed at z 0 when no tile records a stage z; a z for some tiles only is refused
  // rather than putting the others at stage z 0.
  const withZ = stages.filter((stage) => Number.isFinite(stage.z)).length;
  if (dims > 2 && withZ > 0 && withZ < stages.length) {
    const first = stages.findIndex((stage) => !Number.isFinite(stage.z));
    throw new Error(`Tile ${first + 1} has no stage z position but other tiles do; give every tile a z or none.`);
  }
  const common = checkPixelSizes(pixelSizes, dims);
  const axes = ['x', 'y', 'z'].slice(0, dims);
  const raw = stages.map((stage) => {
    const position = [stage.x, stage.y];
    if (dims > 2) position.push(withZ ? stage.z : 0);
    return position;
  });
  const minimum = raw[0].map((_, d) => Math.min(...raw.map((p) => p[d])));
  return raw.map((p) => p.map((v, d) => (v - minimum[d]) / common[axes[d]]));
}

/**
 * The tile pairs that overlap under the approximate layout, by at least `minimum` pixels along
 * every axis, as [i, j] with i < j.
 */
export function overlappingPairs(shapes, positions, minimum = 1) {
  const pairs = [];
  for (let i = 0; i < shapes.length; i++) {
    for (let j = i + 1; j < shapes.length; j++) {
      let overlaps = true;
      for (let d = 0; d < shapes[i].length && overlaps; d++) {
        const start = Math.max(positions[i][d], positions[j][d]);
        const end = Math.min(positions[i][d] + shapes[i][d], positions[j][d] + shapes[j][d]);
        overlaps = end - start >= minimum;
      }
      if (overlaps) pairs.push([i, j]);
    }
  }
  return pairs;
}
