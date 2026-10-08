import { estimateBrainAffine, multiply } from './affine.js';
import { conformVolume } from './conform.js';
import { createQcVolume } from './qc.js';
import { analyzeSurfaces, readPatchRoi } from './surface-analysis.js';
import { validatePatchOptions } from './patches.js';
import { shareAssets } from './shared-assets.js';
import { readFloat32Asset, readInt32Asset, writeSurfaceFiles } from './results.js';
import {
  applyAffine,
  cropAndNormalize,
  imageCenter,
  inverseAffine,
  needsConform,
  readVolume,
  surfaceCenter,
} from './volume.js';

const TREGA_SHAPE = [192, 224, 192];
const TOPOFIT_SHAPE = [176, 208, 176];
const FEATURE_SHAPES = [
  [1, 128, 22, 26, 22],
  [1, 64, 44, 52, 44],
  [1, 32, 88, 104, 88],
  [1, 16, 176, 208, 176],
];
export const MODELS = Object.freeze(['t1w-1mm']);
const WHITE_ORDERS = 6;
const PIAL_ORDER = WHITE_ORDERS + 1;

export async function runTopofit(options) {
  const {
    buffer,
    model = 't1w-1mm',
    conform = true,
    overlayThickness = 1,
    loadAsset,
    createSession,
    Tensor,
    onProgress = () => {},
    runtime = {},
  } = options;
  if (!(buffer instanceof ArrayBuffer)) throw new Error('TopoFit requires NIfTI bytes.');
  if (!MODELS.includes(model)) throw new Error(`Unknown TopoFit model ${model}. Available: ${MODELS.join(', ')}.`);
  if (typeof loadAsset !== 'function' || typeof createSession !== 'function' || typeof Tensor !== 'function') {
    throw new Error('TopoFit runtime dependencies are missing.');
  }
  const started = performance.now();
  const timings = [];
  let lapStarted = started;
  const lap = (stage, seconds) => {
    const now = performance.now();
    timings.push({ stage, seconds: seconds ?? (now - lapStarted) / 1000 });
    lapStarted = now;
  };
  const inputSha256 = await sha256(buffer);
  onProgress(0.01, 'Reading input image…');
  const source = readVolume(buffer);
  const patches = options.patches ? validatePatchOptions(options.patches) : null;
  const roi = patches ? readPatchRoi(options.roiBuffer, source) : null;
  lap('read input');
  let inference = source;
  let conformed = false;
  if (conform && needsConform(source.affine)) {
    onProgress(0.03, 'Conforming to the 1 mm RAS model grid…');
    inference = conformVolume(source, {
      onProgress: (fraction) => onProgress(0.03 + fraction * 0.025, 'Conforming to the 1 mm RAS model grid…'),
    });
    conformed = true;
    lap('conform');
  } else if (needsConform(source.affine)) {
    throw new Error('This scan is not a 1 mm RAS image. Enable conforming to reconstruct it.');
  }
  const inferenceSha256 = await sha256(inference.data);
  lap('hash inference input');

  onProgress(0.06, 'Loading affine-registration model…');
  const tregaBytes = await loadAsset('trega-synth-random.onnx', 0.06, 0.15);
  lap('load trega');
  let session = await createSession(tregaBytes);
  lap('session trega');
  const tregaInput = cropAndNormalize(inference, TREGA_SHAPE, imageCenter(inference.dims));
  lap('normalize trega input');
  onProgress(0.16, 'Estimating subject alignment…');
  const tregaOutput = await session.run({
    image: new Tensor('float32', tregaInput.data, [1, 1, ...TREGA_SHAPE]),
    voxel_to_ras: new Tensor('float32', Float32Array.from(tregaInput.affine.flat()), [1, 4, 4]),
  });
  lap('run trega');
  await releaseSession(session);
  session = null;
  const brainAffine = estimateBrainAffine(
    tregaOutput.targets.data,
    tregaOutput.weights.data,
    tregaOutput.templates.data,
  );
  disposeOutput(tregaOutput);
  lap('estimate affine');

  const [templateLeftBytes, templateRightBytes, registrationLeftBytes, registrationRightBytes] = await Promise.all([
    loadAsset('template-lh.f32', 0.17, 0.18),
    loadAsset('template-rh.f32', 0.18, 0.19),
    loadAsset('registration-lh.f32', 0.19, 0.2),
    loadAsset('registration-rh.f32', 0.2, 0.21),
  ]);
  lap('load templates');
  const worldToVoxel = inverseAffine(inference.affine);
  const templateTransform = multiply(worldToVoxel, brainAffine);
  const subjectLeft = applyAffine(templateTransform, readFloat32Asset(templateLeftBytes));
  const subjectRight = applyAffine(templateTransform, readFloat32Asset(templateRightBytes));
  const center = surfaceCenter(subjectLeft, subjectRight);
  const prepared = cropAndNormalize(inference, TOPOFIT_SHAPE, center);
  const alignmentInputSha256 = await sha256(tregaInput.data);
  const modelInputSha256 = await sha256(prepared.data);
  const croppedLeft = translate(subjectLeft, prepared.offset, -1);
  const croppedRight = translate(subjectRight, prepared.offset, -1);
  lap('normalize model input');

  const contrast = model.split('-')[0];
  onProgress(0.22, `Loading ${contrast.toUpperCase()} feature model…`);
  const featureBytes = await loadAsset(`topofit-${contrast}-1mm-features.onnx`, 0.22, 0.34);
  lap('load features');
  session = await createSession(featureBytes);
  lap('session features');
  onProgress(0.35, 'Extracting multiscale image features…');
  const features = await session.run({
    image: new Tensor('float32', prepared.data, [1, 1, ...TOPOFIT_SHAPE]),
  });
  lap('run features');
  await releaseSession(session);
  session = null;

  const featureArrays = {};
  for (let level = 0; level < FEATURE_SHAPES.length; level += 1) {
    featureArrays[`dec${level}`] = features[`dec${level}`].data;
  }
  disposeOutput(features);
  lap('prepare feature feed');

  const orders = { lh: 0, rh: 0 };
  const onOrder = (hemisphere, order) => {
    orders[hemisphere] = order;
    const behind = Math.min(orders.lh, orders.rh);
    if (behind === PIAL_ORDER) onProgress(0.87, 'Reconstructing pial surfaces…');
    else onProgress(0.54 + behind * 0.045, `Reconstructing cortical mesh · order ${behind} of 6…`);
  };
  const sequential = async (input) => {
    const sharedAsset = shareAssets(loadAsset);
    const results = {};
    for (const hemisphere of ['lh', 'rh']) {
      results[hemisphere] = await reconstructHemisphere({
        ...input.hemispheres[hemisphere],
        hemisphere,
        features: input.features,
        contrast,
        loadAsset: sharedAsset,
        createSession,
        Tensor,
        lap,
        onOrder: (order) => input.onOrder(hemisphere, order),
      });
    }
    return results;
  };
  const reconstructHemispheres = options.reconstructHemispheres ?? sequential;
  const reconstructed = await reconstructHemispheres({
    features: featureArrays,
    hemispheres: {
      lh: { vertices: croppedLeft, registration: readFloat32Asset(registrationLeftBytes) },
      rh: { vertices: croppedRight, registration: readFloat32Asset(registrationRightBytes) },
    },
    contrast,
    onOrder,
    lap,
  });
  const vertices = {};
  for (const hemisphere of ['lh', 'rh']) {
    const result = reconstructed[hemisphere];
    vertices[`${hemisphere}.white`] = applyAffine(prepared.affine, result.white);
    vertices[`${hemisphere}.pial`] = applyAffine(prepared.affine, result.pial);
    vertices[`${hemisphere}.registration`] = result.registration;
  }
  lap('surface coordinates');

  onProgress(0.92, 'Writing FreeSurfer surfaces and QC image…');
  const [facesLeftBytes, facesRightBytes] = await Promise.all([
    loadAsset('faces-lh.i32', 0.91, 0.92),
    loadAsset('faces-rh.i32', 0.92, 0.93),
  ]);
  lap('load faces');
  const faces = {
    lh: readInt32Asset(facesLeftBytes),
    rh: readInt32Asset(facesRightBytes),
  };
  const files = writeSurfaceFiles(vertices, faces);
  lap('write surfaces');
  let analysis;
  if (options.estimateNormals || patches) {
    onProgress(0.94, 'Estimating cortical surface normals…');
    const result = await analyzeSurfaces({
      source, vertices, faces, roi, patches,
      estimateNormals: options.estimateNormals,
      loadAtlas: options.loadAtlas,
      onProgress: (message) => onProgress(0.96, message),
    });
    files.push(...result.files);
    analysis = result.analysis;
    lap('surface analysis');
  }
  const outputSha256 = Object.fromEntries(
    await Promise.all(files.map(async (file) => [file.name, await sha256(file.bytes)])),
  );
  lap('hash outputs');
  const qc = createQcVolume(source, vertices, overlayThickness);
  lap('qc volume');
  files.unshift({ id: 'qc', name: 'topofit_qc.nii', mediaType: 'application/nifti', bytes: qc });
  outputSha256['topofit_qc.nii'] = await sha256(qc);
  lap('hash qc');
  const provenance = {
    schemaVersion: 2,
    status: 'SURFACE_READY',
    model,
    conformed,
    sourceShape: source.dims,
    inferenceShape: inference.dims,
    alignmentAffine: brainAffine,
    alignmentCropOffset: tregaInput.offset,
    modelCropOffset: prepared.offset,
    modelCropAffine: prepared.affine,
    surfaceVertices: vertices['lh.white'].length / 3,
    surfaceFaces: faces.lh.length / 3,
    inputSha256,
    inferenceSha256,
    alignmentInputSha256,
    modelInputSha256,
    outputSha256,
    runtime: {
      ...runtime,
      conformer: conformed ? '@neurodesk/topofit cubic B-spline (order 3), 1 mm RAS' : 'none',
    },
    ...(analysis ? { surfaceAnalysis: analysis } : {}),
    ...(roi ? { roiSha256: await sha256(options.roiBuffer) } : {}),
  };
  files.push({
    id: 'provenance',
    name: 'topofit_manifest.json',
    mediaType: 'application/json',
    bytes: encoder.encode(`${JSON.stringify(provenance, null, 2)}\n`).buffer,
  });
  onProgress(1, 'Cortical surfaces ready');
  lap('manifest');
  return { files, provenance, surfaces: { vertices, faces }, elapsedSeconds: (performance.now() - started) / 1000, timings };
}

export async function reconstructHemisphere({
  hemisphere,
  features,
  vertices: initialVertices,
  registration: initialRegistration,
  contrast,
  loadAsset,
  createSession,
  Tensor,
  onOrder = () => {},
  lap = () => {},
}) {
  const featureFeed = {};
  for (let level = 0; level < FEATURE_SHAPES.length; level += 1) {
    featureFeed[`dec${level}`] = new Tensor('float32', features[`dec${level}`], FEATURE_SHAPES[level]);
  }
  let vertices = initialVertices;
  let registration = initialRegistration;
  let uncertainty = new Float32Array(vertices.length);
  for (let order = 0; order <= WHITE_ORDERS; order += 1) {
    onOrder(order);
    const stageBytes = await loadAsset(
      `topofit-${contrast}-1mm-white-order-${order}.onnx`,
      0.54 + order * 0.045,
      0.57 + order * 0.045,
    );
    lap(`load white-order-${order} ${hemisphere}`);
    const session = await createSession(stageBytes);
    lap(`session white-order-${order} ${hemisphere}`);
    const steps = order === WHITE_ORDERS ? 1 : 2;
    for (let step = 0; step < steps; step += 1) {
      const count = vertices.length / 3;
      const output = await session.run({
        ...featureFeed,
        vertices: new Tensor('float32', vertices, [1, count, 3]),
        uncertainty: new Tensor('float32', uncertainty, [1, count, 3]),
        registration: new Tensor('float32', registration, [1, count, 3]),
      });
      lap(`run white-order-${order} ${hemisphere}`);
      vertices = Float32Array.from(output.vertices_out.data);
      uncertainty = Float32Array.from(output.uncertainty_out.data);
      registration = Float32Array.from(output.registration_out.data);
      disposeOutput(output);
      lap(`copy white-order-${order} ${hemisphere}`);
    }
    await releaseSession(session);
    if (order < WHITE_ORDERS) {
      const edges = readInt32Asset(await loadAsset(`subdivide-order-${order}-edges.i32`, 0.57, 0.58));
      lap(`load subdivide-order-${order} ${hemisphere}`);
      vertices = subdivide(vertices, edges, false);
      uncertainty = subdivide(uncertainty, edges, false);
      registration = subdivide(registration, edges, true);
      lap(`subdivide order-${order} ${hemisphere}`);
    }
  }

  onOrder(PIAL_ORDER);
  const pialBytes = await loadAsset(`topofit-${contrast}-1mm-pial.onnx`, 0.87, 0.9);
  lap(`load pial ${hemisphere}`);
  const session = await createSession(pialBytes);
  lap(`session pial ${hemisphere}`);
  let pial = vertices;
  for (let step = 0; step < 10; step += 1) {
    const count = pial.length / 3;
    const output = await session.run({
      ...featureFeed,
      white: new Tensor('float32', pial, [1, count, 3]),
      uncertainty: new Tensor('float32', uncertainty, [1, count, 3]),
    });
    lap(`run pial ${hemisphere}`);
    pial = Float32Array.from(output.pial.data);
    uncertainty = Float32Array.from(output.uncertainty_out.data);
    disposeOutput(output);
    lap(`copy pial ${hemisphere}`);
  }
  await releaseSession(session);
  disposeOutput(featureFeed);
  return { white: vertices, pial, registration };
}

export async function runSurfaceAnalysis({ buffer, surfaces, provenance: reconstruction, estimateNormals, patches, roiBuffer, loadAtlas, cortexAtlasSha256, onProgress = () => {} }) {
  if (!estimateNormals && !patches) throw new Error('Choose normals, flat patches, or both.');
  const started = performance.now();
  const source = readVolume(buffer);
  const roi = readPatchRoi(roiBuffer, source);
  onProgress(0.05, 'Analyzing reconstructed surfaces…');
  const result = await analyzeSurfaces({
    source, ...surfaces, estimateNormals, patches, roi, loadAtlas,
    onProgress: (message) => onProgress(0.5, message),
  });
  const provenance = structuredClone(reconstruction);
  delete provenance.roiSha256;
  delete provenance.runtime.cortexAtlasSha256;
  provenance.surfaceAnalysis = result.analysis;
  provenance.outputSha256 = Object.fromEntries(
    [...Object.keys(surfaces.vertices), 'lh.mid.white', 'rh.mid.white', 'topofit_qc.nii'].map((name) => [name, reconstruction.outputSha256[name]]),
  );
  if (roi) provenance.roiSha256 = await sha256(roiBuffer);
  if (patches) provenance.runtime.cortexAtlasSha256 = cortexAtlasSha256;
  for (const file of result.files) provenance.outputSha256[file.name] = await sha256(file.bytes);
  result.files.push({
    id: 'provenance', name: 'topofit_manifest.json', mediaType: 'application/json',
    bytes: encoder.encode(`${JSON.stringify(provenance, null, 2)}\n`).buffer,
  });
  onProgress(1, 'Surface analysis ready');
  return { files: result.files, provenance, elapsedSeconds: (performance.now() - started) / 1000 };
}

const encoder = new TextEncoder();

function translate(vertices, offset, direction) {
  const output = new Float32Array(vertices.length);
  for (let i = 0; i < vertices.length; i += 3) {
    output[i] = vertices[i] + direction * offset[0];
    output[i + 1] = vertices[i + 1] + direction * offset[1];
    output[i + 2] = vertices[i + 2] + direction * offset[2];
  }
  return output;
}

function subdivide(vertices, edges, projectToSphere) {
  const oldCount = vertices.length / 3;
  const output = new Float32Array(vertices.length + (edges.length / 2) * 3);
  output.set(vertices);
  for (let edge = 0; edge < edges.length / 2; edge += 1) {
    const target = (oldCount + edge) * 3;
    const first = edges[edge * 2] * 3;
    const second = edges[edge * 2 + 1] * 3;
    for (let axis = 0; axis < 3; axis += 1) output[target + axis] = 0.5 * (vertices[first + axis] + vertices[second + axis]);
  }
  if (projectToSphere) {
    for (let i = 0; i < output.length; i += 3) {
      const length = Math.hypot(output[i], output[i + 1], output[i + 2]);
      output[i] = (output[i] * 100) / length;
      output[i + 1] = (output[i + 1] * 100) / length;
      output[i + 2] = (output[i + 2] * 100) / length;
    }
  }
  return output;
}

async function releaseSession(session) {
  if (typeof session.release === 'function') await session.release();
}

function disposeOutput(output) {
  for (const tensor of Object.values(output)) tensor?.dispose?.();
}

async function sha256(value) {
  const bytes = ArrayBuffer.isView(value)
    ? value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
    : value;
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
