// The Brain2Print pipeline without a viewer: MindGrab segmentation, a niimath mesh, then the
// manifold and winding check. The web app and the brain2print command line inject their own
// MindGrab and niimath runtimes, so both write the same files.
import { readMz3, writeMz3, writeStl } from '@neurodesk/webapp-components/file-io/mesh';
import { createFloat32Nifti, extractNiftiHeader, readNiftiImageData } from '@neurodesk/webapp-components/file-io/nifti';
import { flipWinding, inspectMesh } from './mesh.js';

// The web app's create-mesh automation parameters (apps/brain2print/automation.json).
export const PARAMETERS = Object.freeze({
  model: {
    type: 'string',
    default: 'pve',
    enum: ['pve', '16chan18cls', 'mindmap', 'mindsnap'],
    description: 'Published model variant',
  },
  backend: {
    type: 'string',
    default: 'auto',
    enum: ['auto', 'cpu'],
    description: 'Segmentation backend',
  },
  simplify: {
    type: 'number',
    default: 20,
    minimum: 5,
    maximum: 100,
    description: 'Percentage of mesh faces to retain',
  },
  smooth: {
    type: 'integer',
    default: 0,
    minimum: 0,
    maximum: 20,
    description: 'Mesh smoothing iterations',
  },
  largestOnly: {
    type: 'boolean',
    default: true,
    description: 'Keep only the largest mesh component',
  },
  fillBubbles: {
    type: 'boolean',
    default: true,
    description: 'Fill internal mesh bubbles',
  },
});

// pve is mindmap's partial-volume estimate; the others are label maps.
const MINDGRAB_MODELS = Object.freeze({
  pve: 'mindmap',
  '16chan18cls': '16chan18cls',
  mindmap: 'mindmap',
  mindsnap: 'mindsnap',
});

export const OUTPUT_NAMES = Object.freeze({
  fraction: 'brain-fraction.nii',
  labels: 'segmentation.nii',
  stl: 'brain2print.stl',
  mz3: 'brain2print.mz3',
});

// Both surfaces are meshed at 0.5: the brain fraction, or a label map's 0/1 brain mask.
const ISOVALUE = 0.5;

/**
 * Segment one NIfTI image (gzipped or not).
 * `mindgrab` has the wrapper's `segment` and `segmentTissues` and its package `version`.
 * Returns the uncompressed NIfTI the app shows and offers for download (`bytes`) and the
 * volume the mesh step surfaces at 0.5 (`surface`).
 */
export async function segmentBrain(mindgrab, input, model, options = {}) {
  if (!Object.hasOwn(MINDGRAB_MODELS, model)) throw new Error(`Unknown model ${model}.`);
  const partialVolume = model === 'pve';
  const settings = { ...options, model: MINDGRAB_MODELS[model], gzipOutput: false };
  const result = partialVolume ? await mindgrab.segmentTissues(input, settings) : await mindgrab.segment(input, settings);
  const provenance = {
    model: settings.model,
    partialVolume,
    version: mindgrab.version,
    backend: result.backend,
    elapsedMs: result.elapsedMs,
  };
  if (!partialVolume) {
    // Mesh the 0/1 brain mask, not the label values. Marching cubes interpolates between voxel
    // centres, so at isovalue 0.5 a 0/1 edge is cut half way and the surface encloses the
    // labelled voxels (skimage on the 2 mm fixture: within 0.5 %). A raw label L puts the cut
    // (L - 0.5) / L of the way out, almost at the background voxel, and niimath's volume
    // smoothing spreads large labels further still: 17-20 % too large, mindsnap (up to 103) 87 %.
    const values = readNiftiImageData(result.image).data;
    const mask = new Float32Array(values.length);
    for (let i = 0; i < values.length; i++) mask[i] = values[i] > 0 ? 1 : 0;
    const surface = new Uint8Array(createFloat32Nifti(mask, extractNiftiHeader(result.image)));
    return { bytes: new Uint8Array(result.image), surface, name: OUTPUT_NAMES.labels, type: 'neuro:label-map', provenance };
  }
  // Brain fraction = GM + WM; its 0.5 isosurface is a sub-voxel pial surface.
  const brain = readNiftiImageData(result.tissues.gm).data;
  const wm = readNiftiImageData(result.tissues.wm).data;
  for (let i = 0; i < brain.length; i++) brain[i] += wm[i];
  const bytes = new Uint8Array(createFloat32Nifti(brain, extractNiftiHeader(result.tissues.gm)));
  return { bytes, surface: bytes, name: OUTPUT_NAMES.fraction, type: 'neuro:volume', provenance };
}

/** niimath's mesh sub-options for the app's settings, in the order the app has always passed them. */
export function meshOptions({ largestOnly, fillBubbles, simplify, smooth }) {
  return {
    i: ISOVALUE,
    l: largestOnly ? 1 : 0,
    b: fillBubbles ? 1 : 0,
    r: simplify / 100,
    s: smooth,
  };
}

/** The argv @niivue/niimath's fluent `.mesh(options)` builds. */
export function meshArgs(options) {
  return ['-mesh', ...Object.entries(options).flatMap(([key, value]) => [`-${key}`, String(value)])];
}

/**
 * Read niimath's mz3 and orient it for printing. Only a closed, consistently wound mesh has a
 * meaningful inside, so only then is a negative volume evidence of inward normals worth correcting.
 */
export async function orientMesh(mz3) {
  const { vertices: positions, faces: indices } = await readMz3(mz3);
  const found = inspectMesh({ positions, indices });
  const closed = found.manifold && found.consistent;
  const windingCorrected = closed && found.signedVolume < 0;
  if (windingCorrected) flipWinding(indices);
  return {
    positions,
    indices,
    closed,
    measurements: { ...inspectMesh({ positions, indices }), windingCorrected, triangles: indices.length / 3 },
  };
}

/**
 * Mesh a segmentation. `mesher(niftiBytes, options)` runs niimath's mesh with the given
 * sub-options and resolves to the mz3 it writes.
 */
export async function buildMesh(mesher, segmentation, settings) {
  const options = meshOptions(settings);
  const mesh = await orientMesh(await mesher(segmentation, options));
  return { ...mesh, provenance: { algorithm: 'niimath mesh', options } };
}

/** The STL and MZ3 downloads of an oriented mesh. */
export function meshFiles({ positions, indices }) {
  return [
    { role: 'mesh', name: OUTPUT_NAMES.stl, bytes: new Uint8Array(writeStl(positions, indices)) },
    { role: 'geometry', name: OUTPUT_NAMES.mz3, bytes: new Uint8Array(writeMz3(positions, indices)) },
  ];
}

/**
 * The whole create-mesh operation: segmentation, mesh and the three files the app offers,
 * with the measurements and provenance of its automation report.
 */
export async function createMesh({ input, settings, mindgrab, mesher, mindgrabOptions = {}, onProgress = () => {} }) {
  onProgress('Segmenting brain tissues');
  const segmentation = await segmentBrain(mindgrab, input, settings.model, { backend: settings.backend, ...mindgrabOptions });
  onProgress('Creating brain mesh');
  const mesh = await buildMesh(mesher, segmentation.surface, settings);
  return {
    files: [{ role: 'segmentation', name: segmentation.name, type: segmentation.type, bytes: segmentation.bytes }, ...meshFiles(mesh)],
    measurements: mesh.measurements,
    provenance: { segmentation: segmentation.provenance, meshing: mesh.provenance },
  };
}
