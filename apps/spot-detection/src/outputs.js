// Spot and per-cell tables. Pure, so the app, the worker and the tests share them.

const AXES = { 2: ["y", "x"], 3: ["z", "y", "x"] };

function offsetOf(coord, shape) {
  let offset = 0;
  for (let a = 0; a < shape.length; a++) offset = offset * shape[a] + coord[a];
  return offset;
}

// The label under each spot: a 2D label image (y, x) applies to every plane, as in
// Big-FISH's multistack.extract_cell; a 3D one must match the image grid.
export function cellIds(spots, labels, imageShape) {
  if (!labels) return null;
  const yx = imageShape.slice(-2);
  const fits = labels.shape.length === imageShape.length
    ? labels.shape.every((n, a) => n === imageShape[a])
    : labels.shape.length === 2 && labels.shape.every((n, a) => n === yx[a]);
  if (!fits) {
    throw new Error(`The cell labels (${labels.shape.join(" × ")}) must match the image (${imageShape.join(" × ")}) or its y × x plane.`);
  }
  return spots.map((spot) => labels.data[offsetOf(labels.shape.length === 2 ? spot.slice(-2) : spot, labels.shape)]);
}

// Spots per cell label (label 0 is background), with each cell's area in label voxels.
export function cellCounts(ids, labels) {
  const area = new Map();
  for (let i = 0; i < labels.data.length; i++) {
    const id = labels.data[i];
    if (id > 0) area.set(id, (area.get(id) ?? 0) + 1);
  }
  const counts = new Map([...area.keys()].map((id) => [id, 0]));
  let outside = 0;
  for (const id of ids) {
    if (id > 0) counts.set(id, counts.get(id) + 1);
    else outside++;
  }
  const cells = [...area.keys()].sort((a, b) => a - b).map((id) => ({ id, spots: counts.get(id), area: area.get(id) }));
  return { cells, outside };
}

const fixed = (value) => (Number.isInteger(value) ? String(value) : value.toFixed(4));

// One row per spot: sub-pixel position, integer voxel, raw intensity, LoG response, cell.
export function spotsCsv({ spots, subpixel, image, filtered, ids }) {
  const axes = AXES[image.shape.length];
  const header = ["spot_id", ...axes, ...axes.map((a) => `${a}_px`), "intensity", "log_response"];
  if (ids) header.push("cell_id");
  const rows = spots.map((spot, i) => {
    const offset = offsetOf(spot, image.shape);
    const row = [i + 1, ...subpixel[i].map(fixed), ...spot, image.data[offset], fixed(filtered.data[offset])];
    if (ids) row.push(ids[i]);
    return row.join(",");
  });
  return [header.join(","), ...rows].join("\n") + "\n";
}

export function cellsCsv({ cells, outside }) {
  const rows = cells.map((cell) => [cell.id, cell.spots, cell.area].join(","));
  return ["cell_id,spots,area_px", ...rows, `0,${outside},`].join("\n") + "\n";
}
