// The app's whole analysis, shared by the worker and the validation script.
import { detectSpots, maximumProjection } from "./bigfish.js";
import { fitSubpixel } from "./subpixel.js";
import { cellCounts, cellIds, cellsCsv, spotsCsv } from "./outputs.js";

// image: { data, shape, dtype }; voxelSize and spotRadius in nm, one per image axis
// (z, y, x) or (y, x). projection: detect on the 2D maximum projection of a stack.
export function analyse(image, { voxelSize, spotRadius, threshold = null, projection = false, subpixel = true, labels = null, onProgress = () => {} }) {
  const source = projection && image.shape.length === 3 ? maximumProjection(image) : image;
  const ndim = source.shape.length;
  const voxel = voxelSize.slice(-ndim);
  const radius = spotRadius.slice(-ndim);
  const detection = detectSpots(source, { voxelSize: voxel, spotRadius: radius, threshold, onProgress });
  onProgress("Sub-pixel fit", 0.8);
  const positions = subpixel ? fitSubpixel(source, detection.spots, { voxelSize: voxel, spotRadius: radius }) : detection.spots.map((s) => s.slice());
  const ids = cellIds(detection.spots, labels, source.shape);
  const cells = ids ? cellCounts(ids, labels) : null;
  return {
    image: source,
    sigma: detection.sigma,
    threshold: detection.threshold,
    automaticThreshold: detection.automaticThreshold,
    curve: detection.curve,
    spots: detection.spots,
    subpixel: positions,
    ids,
    cells,
    spotsCsv: spotsCsv({ spots: detection.spots, subpixel: positions, image: source, filtered: detection.filtered, ids }),
    cellsCsv: cells ? cellsCsv(cells) : null,
  };
}
