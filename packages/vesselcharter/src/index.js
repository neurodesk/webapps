// Public DOM-free barrel for @neurodesk/vesselcharter.
// Runs identically in browser Web Workers, Node tests, and the standalone CLI.
import { operationParametersSchema } from '@neurodesk/webapp-components/automation/parameters';
import PARAMETERS from './parameters.json' with { type: 'json' };
import { euclideanDistanceTransform3D, pointToBackgroundBoxDistance, subvoxelInscribedRadius } from './edt.js';
import { DIAMETER_BINS, computeSoamRadPerMm, measureVesselNetwork, smoothCenterlineVox } from './geometry.js';
import { extractVesselGraph } from './graph.js';
import { EULER_LUT, isEulerInvariant, isSimplePoint, lee94Skeletonize } from './lee94.js';
import {
  TURBO_COLORMAP,
  buildOutputArtifacts,
  buildVesselTreeMz3,
  buildVesselTreeScalars,
  computeDiameterDisplayRange,
  formatDiameterBinsCsv,
  formatGraphJson,
  formatJunctionsCsv,
  formatSegmentsCsv,
  sampleColormapRgba,
  stemFromFilename,
} from './outputs.js';
import {
  MAX_DECOMPRESSED_BYTES,
  MAX_VOXELS,
  assertMatchingGrid,
  computeForegroundBBox,
  cropMaskWithPad,
  fillInteriorHoles3D,
  filterConnectedComponents26,
  gunzipBytes,
  gzipBytes,
  inspectAffine,
  readBinaryMaskNifti,
  spatialUnitsToMm,
  voxelToWorld,
} from './volume.js';

export {
  DIAMETER_BINS,
  EULER_LUT,
  MAX_DECOMPRESSED_BYTES,
  MAX_VOXELS,
  PARAMETERS,
  TURBO_COLORMAP,
  assertMatchingGrid,
  buildOutputArtifacts,
  buildVesselTreeMz3,
  buildVesselTreeScalars,
  computeDiameterDisplayRange,
  computeForegroundBBox,
  computeSoamRadPerMm,
  cropMaskWithPad,
  euclideanDistanceTransform3D,
  extractVesselGraph,
  fillInteriorHoles3D,
  filterConnectedComponents26,
  formatDiameterBinsCsv,
  formatGraphJson,
  formatJunctionsCsv,
  formatSegmentsCsv,
  gunzipBytes,
  gzipBytes,
  inspectAffine,
  isEulerInvariant,
  isSimplePoint,
  lee94Skeletonize,
  measureVesselNetwork,
  pointToBackgroundBoxDistance,
  readBinaryMaskNifti,
  sampleColormapRgba,
  smoothCenterlineVox,
  spatialUnitsToMm,
  stemFromFilename,
  subvoxelInscribedRadius,
  voxelToWorld,
};

const SCHEMA = operationParametersSchema(PARAMETERS);

export function parseParameters(raw = {}) {
  const cleaned = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) {
      continue;
    }
    if (!Object.hasOwn(PARAMETERS, key)) {
      throw new Error(`Unknown VesselCharter setting: ${key}.`);
    }
    cleaned[key] = value;
  }
  const parsed = SCHEMA.safeParse(cleaned);
  if (parsed.success) {
    return parsed.data;
  }
  const [issue] = parsed.error.issues;
  throw new Error(`Invalid setting ${String(issue.path[0])}: ${issue.message}`);
}

/**
 * Characterises a 3D binary vessel mask (already decoded into Uint8Array) with
 * optional same-grid brain/ROI mask.
 */
export function characterizeVesselMask({
  mask,
  dims,
  spatial,
  header = null,
  brainMask = null,
  parameters = {},
  onProgress = () => {},
}) {
  const settings = parseParameters(parameters);
  onProgress(0.05, 'Inspecting vessel mask bounds…');

  const bbox = computeForegroundBBox(mask, dims);
  if (!bbox || bbox.count === 0) {
    throw new Error('The vessel mask contains no foreground voxels above the threshold.');
  }

  const cropped = cropMaskWithPad(mask, dims, bbox, 1);
  let workMask = cropped.mask;
  const cropDims = cropped.dims;
  const cropOffset = cropped.offset;

  let holesFilledVoxels = 0;
  if (settings.fillHoles) {
    onProgress(0.14, 'Filling interior cavities…');
    const filled = fillInteriorHoles3D(workMask, cropDims);
    workMask = filled.mask;
    holesFilledVoxels = filled.filledVoxels;
  }

  onProgress(0.24, 'Filtering connected vessel components…');
  const cc = filterConnectedComponents26(workMask, cropDims, settings.minComponentVoxels);
  if (cc.retainedVoxels === 0) {
    throw new Error(
      `All ${cc.inputComponentCount} vessel components were smaller than minComponentVoxels=${settings.minComponentVoxels}.`,
    );
  }
  workMask = cc.mask;

  onProgress(0.36, 'Computing exact anisotropic distance transform…');
  const edtMm = euclideanDistanceTransform3D(workMask, cropDims, spatial.spacing, {
    float32: cropDims[0] * cropDims[1] * cropDims[2] > 16 * 1024 * 1024,
  });

  onProgress(0.52, 'Extracting 3D medial-axis skeleton (Lee94)…');
  const { skeleton, passes } = lee94Skeletonize(workMask, cropDims, { padded: true });

  onProgress(0.72, 'Building vessel topology graph & pruning spurs…');
  const graph = extractVesselGraph(skeleton, cropDims, spatial.spacing, edtMm, {
    originalDims: dims,
    cropOffset,
    minSpurLengthMm: settings.minSpurLengthMm,
    pruneContainedSpurs: settings.pruneContainedSpurs,
    minIsolatedLengthMm: settings.minIsolatedLengthMm,
  });

  onProgress(0.84, 'Measuring diameters, tortuosity, branching & Voronoi volumes…');
  const measured = measureVesselNetwork(graph, workMask, cropDims, spatial, edtMm, {
    originalDims: dims,
    cropOffset,
    smoothIterations: settings.smoothIterations,
    brainMask,
    inputVesselVoxels: bbox.count,
    retainedVesselVoxels: cc.retainedVoxels,
    holesFilledVoxels,
    touchesFovVoxels: bbox.touchesFovCount,
    componentStats: cc,
  });

  measured.summary.parameters = settings;
  measured.summary.processing = { lee94Passes: passes };
  onProgress(0.95, 'Preparing output files…');

  return {
    ...measured,
    graph,
    cropDims,
    cropOffset,
    skeletonCrop: skeleton,
    edtCropMm: edtMm,
    inputHeader: header ?? {
      version: 1,
      transforms: null,
    },
    inputSpatial: spatial,
  };
}

/**
 * Full NIfTI-to-characterisation entrypoint used by both the Web Worker and CLI.
 */
export async function characterizeVesselNifti({
  vesselBytes,
  brainMaskBytes = null,
  parameters = {},
  baseName = 'vessels.nii.gz',
  onProgress = () => {},
}) {
  const settings = parseParameters(parameters);
  onProgress(0.02, 'Reading vessel mask NIfTI…');
  const vesselVol = await readBinaryMaskNifti(vesselBytes, {
    threshold: settings.maskThreshold,
  });

  let brainMask = null;
  if (brainMaskBytes) {
    onProgress(0.04, 'Reading brain / ROI mask NIfTI…');
    const roiVol = await readBinaryMaskNifti(brainMaskBytes, { threshold: 0 });
    assertMatchingGrid(vesselVol, roiVol, 'Brain/ROI mask');
    if (roiVol.foregroundCount === 0) {
      throw new Error('The brain / ROI mask contains no nonzero voxels.');
    }
    brainMask = roiVol.mask;
  }

  const result = characterizeVesselMask({
    mask: vesselVol.mask,
    dims: vesselVol.dims,
    spatial: vesselVol.spatial,
    header: vesselVol.header,
    brainMask,
    parameters: settings,
    onProgress,
  });

  const artifacts = await buildOutputArtifacts(result, { baseName });
  onProgress(1.0, 'Vessel characterisation complete');
  return { result, artifacts };
}
