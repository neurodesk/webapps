// Regions: the Allen structure table, per-hemisphere region volumes in the sample, candidate
// assignment through the atlas coordinates, and the CSV report. Detected structures are cell
// candidates (no classifier runs), so the report counts candidates.

import { sampleTrilinear } from './registration.js';

/** Index the structures file (allen_mouse_50um_structures.json). */
export function structureTable(json) {
  const byIndex = new Map();
  const byId = new Map();
  for (const structure of json.structures) {
    byId.set(structure.id, structure);
    if (structure.index) byIndex.set(structure.index, structure);
  }
  return { byIndex, byId, rightBelow: json.right_hemisphere_axis2_below, shape: json.shape, resolutionUm: json.resolution_um };
}

/** BrainGlobe's hemisphere for an atlas axis-2 index (asr: low indices are the right side). */
export const hemisphereOf = (r, table) => (Math.round(r) < table.rightBelow ? 'right' : 'left');

/**
 * Region volumes in the sample, per hemisphere, from the registered labels (as brainreg's
 * volumes.csv): Map key `${index}:${hemisphere}` -> voxel count. The hemisphere of a sample voxel
 * is that of its atlas coordinate.
 */
export function regionVoxels(labels, coordinates, table) {
  const counts = new Map();
  const axis2 = coordinates[2];
  for (let i = 0; i < labels.length; i++) {
    const index = labels[i];
    if (!index || axis2[i] < 0) continue;
    const key = `${index}:${hemisphereOf(axis2[i], table)}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/**
 * Assign each cell (continuous index on the sample's asr grid) to an atlas voxel and region.
 * Returns rows { grid, atlas: [a, s, r] (atlas voxel index) | null, index, hemisphere }.
 */
export function assignCells(points, { coordinates, gridShape, annotation, table }) {
  const [A, S] = table.shape;
  return points.map((grid) => {
    const atlas = [0, 1, 2].map((axis) => sampleTrilinear(coordinates[axis], gridShape, grid));
    if (atlas.some((value) => value === null)) return { grid, atlas: null, index: 0, hemisphere: null };
    const [a, s, r] = atlas.map(Math.round);
    const index = annotation[a + A * (s + S * r)] ?? 0;
    return { grid, atlas, index, hemisphere: index ? hemisphereOf(atlas[2], table) : null };
  });
}

const csvField = (value) => {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

const format = (value, digits) => (Number.isFinite(value) ? Number(value.toFixed(digits)).toString() : '');

/**
 * One row per region and hemisphere present in the sample: acronym, name, hemisphere, candidate
 * count, region volume (mm^3, in the sample) and density (candidates/mm^3). Without detection
 * the count and density columns are empty.
 */
export function regionReport({ voxels, cells = null, table, voxelVolumeMm3 }) {
  const cellCounts = new Map();
  if (cells) {
    for (const cell of cells) {
      if (!cell.index) continue;
      const key = `${cell.index}:${cell.hemisphere}`;
      cellCounts.set(key, (cellCounts.get(key) ?? 0) + 1);
    }
  }
  const keys = new Set([...voxels.keys(), ...cellCounts.keys()]);
  const rows = [...keys].map((key) => {
    const [index, hemisphere] = key.split(':');
    const structure = table.byIndex.get(Number(index));
    const volume = (voxels.get(key) ?? 0) * voxelVolumeMm3;
    const count = cells ? cellCounts.get(key) ?? 0 : null;
    return {
      acronym: structure.acronym,
      name: structure.name,
      id: structure.id,
      hemisphere,
      count,
      volumeMm3: volume,
      density: count === null || volume === 0 ? null : count / volume,
    };
  });
  rows.sort((p, q) => (q.count ?? 0) - (p.count ?? 0) || p.acronym.localeCompare(q.acronym) || p.hemisphere.localeCompare(q.hemisphere));
  return rows;
}

export function regionCsv(rows) {
  const header = 'acronym,name,structure_id,hemisphere,candidate_count,volume_mm3,candidates_per_mm3';
  const lines = rows.map((row) => [
    row.acronym, row.name, row.id, row.hemisphere,
    row.count ?? '', format(row.volumeMm3, 6), row.density === null ? '' : format(row.density, 3),
  ].map(csvField).join(','));
  return `${header}\n${lines.join('\n')}\n`;
}

/** The candidates CSV: stack voxel (x, y, z), atlas position (µm, asr axes), region and hemisphere. */
export function cellCsv(cells, assigned, table) {
  const header = 'x,y,z,atlas_ap_um,atlas_si_um,atlas_rl_um,acronym,structure_id,hemisphere';
  const res = table.resolutionUm;
  const lines = cells.map(([x, y, z], i) => {
    const row = assigned[i];
    const structure = row.index ? table.byIndex.get(row.index) : null;
    const atlas = row.atlas ? row.atlas.map((v) => format(v * res, 1)) : ['', '', ''];
    return [x, y, z, ...atlas, structure?.acronym ?? '', structure?.id ?? '', row.hemisphere ?? ''].map(csvField).join(',');
  });
  return `${header}\n${lines.join('\n')}\n`;
}
