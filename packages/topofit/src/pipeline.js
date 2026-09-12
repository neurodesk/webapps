import { estimateBrainAffine, multiply } from './affine.js';
import { conformVolume } from './conform.js';
import { createQcVolume } from './qc.js';
import { readFloat32Asset, readInt32Asset, writeFreeSurfer } from './results.js';
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
const MODEL_NAMES = new Set(['t1w-1mm']);

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
  if (!MODEL_NAMES.has(model)) throw new Error(`Unknown TopoFit model ${model}.`);
  if (typeof loadAsset !== 'function' || typeof createSession !== 'function' || typeof Tensor !== 'function') {
    throw new Error('TopoFit runtime dependencies are missing.');
  }
  const started = performance.now();
  const inputSha256 = await sha256(buffer);
  onProgress(0.01, 'Reading input image…');
  const source = readVolume(buffer);
  let inference = source;
  let conformed = false;
  if (conform) {
    onProgress(0.03, 'Conforming to the 1 mm RAS model grid…');
    inference = conformVolume(source, {
      onProgress: (fraction) => onProgress(0.03 + fraction * 0.025, 'Conforming to the 1 mm RAS model grid…'),
    });
    conformed = true;
  } else if (needsConform(source.affine)) {
    throw new Error('This scan is not a 1 mm RAS image. Enable conforming to reconstruct it.');
  }
  const inferenceSha256 = await sha256(inference.data);

  onProgress(0.06, 'Loading affine-registration model…');
  const tregaBytes = await loadAsset('trega-synth-random.onnx', 0.06, 0.15);
  let session = await createSession(tregaBytes);
  const tregaInput = cropAndNormalize(inference, TREGA_SHAPE, imageCenter(inference.dims));
  onProgress(0.16, 'Estimating subject alignment…');
  const tregaOutput = await session.run({
    image: new Tensor('float32', tregaInput.data, [1, 1, ...TREGA_SHAPE]),
    voxel_to_ras: new Tensor('float32', Float32Array.from(tregaInput.affine.flat()), [1, 4, 4]),
  });
  await releaseSession(session);
  session = null;
  const brainAffine = estimateBrainAffine(
    tregaOutput.targets.data,
    tregaOutput.weights.data,
    tregaOutput.templates.data,
  );
  disposeOutput(tregaOutput);

  const [templateLeftBytes, templateRightBytes, registrationLeftBytes, registrationRightBytes] = await Promise.all([
    loadAsset('template-lh.f32', 0.17, 0.18),
    loadAsset('template-rh.f32', 0.18, 0.19),
    loadAsset('registration-lh.f32', 0.19, 0.2),
    loadAsset('registration-rh.f32', 0.2, 0.21),
  ]);
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

  const contrast = model.split('-')[0];
  onProgress(0.22, `Loading ${contrast.toUpperCase()} feature model…`);
  const featureBytes = await loadAsset(`topofit-${contrast}-1mm-features.onnx`, 0.22, 0.34);
  session = await createSession(featureBytes);
  onProgress(0.35, 'Extracting multiscale image features…');
  const features = await session.run({
    image: new Tensor('float32', prepared.data, [1, 1, ...TOPOFIT_SHAPE]),
  });
  await releaseSession(session);
  session = null;

  const states = {
    lh: {
      vertices: croppedLeft,
      uncertainty: new Float32Array(croppedLeft.length),
      registration: readFloat32Asset(registrationLeftBytes),
    },
    rh: {
      vertices: croppedRight,
      uncertainty: new Float32Array(croppedRight.length),
      registration: readFloat32Asset(registrationRightBytes),
    },
  };
  const featureFeed = {};
  for (let level = 0; level < FEATURE_SHAPES.length; level += 1) {
    featureFeed[`dec${level}`] = new Tensor('float32', features[`dec${level}`].data, FEATURE_SHAPES[level]);
  }
  disposeOutput(features);
  for (let order = 0; order <= 6; order += 1) {
    onProgress(0.54 + order * 0.045, `Reconstructing cortical mesh · order ${order} of 6…`);
    const stageBytes = await loadAsset(
      `topofit-${contrast}-1mm-white-order-${order}.onnx`,
      0.54 + order * 0.045,
      0.57 + order * 0.045,
    );
    session = await createSession(stageBytes);
    for (const hemisphere of ['lh', 'rh']) {
      const state = states[hemisphere];
      const steps = order === 6 ? 1 : 2;
      for (let step = 0; step < steps; step += 1) {
        const count = state.vertices.length / 3;
        const output = await session.run({
          ...featureFeed,
          vertices: new Tensor('float32', state.vertices, [1, count, 3]),
          uncertainty: new Tensor('float32', state.uncertainty, [1, count, 3]),
          registration: new Tensor('float32', state.registration, [1, count, 3]),
        });
        state.vertices = Float32Array.from(output.vertices_out.data);
        state.uncertainty = Float32Array.from(output.uncertainty_out.data);
        state.registration = Float32Array.from(output.registration_out.data);
        disposeOutput(output);
      }
    }
    await releaseSession(session);
    session = null;
    if (order < 6) {
      const edges = readInt32Asset(await loadAsset(`subdivide-order-${order}-edges.i32`, 0.57, 0.58));
      for (const state of Object.values(states)) {
        state.vertices = subdivide(state.vertices, edges, false);
        state.uncertainty = subdivide(state.uncertainty, edges, false);
        state.registration = subdivide(state.registration, edges, true);
      }
    }
  }

  onProgress(0.87, 'Reconstructing pial surfaces…');
  const pialBytes = await loadAsset(`topofit-${contrast}-1mm-pial.onnx`, 0.87, 0.9);
  session = await createSession(pialBytes);
  const vertices = {};
  for (const hemisphere of ['lh', 'rh']) {
    const state = states[hemisphere];
    let pial = state.vertices;
    for (let step = 0; step < 10; step += 1) {
      const count = pial.length / 3;
      const output = await session.run({
        ...featureFeed,
        white: new Tensor('float32', pial, [1, count, 3]),
        uncertainty: new Tensor('float32', state.uncertainty, [1, count, 3]),
      });
      pial = Float32Array.from(output.pial.data);
      state.uncertainty = Float32Array.from(output.uncertainty_out.data);
      disposeOutput(output);
    }
    vertices[`${hemisphere}.white`] = applyAffine(prepared.affine, state.vertices);
    vertices[`${hemisphere}.pial`] = applyAffine(prepared.affine, pial);
    vertices[`${hemisphere}.registration`] = state.registration;
  }
  await releaseSession(session);
  disposeOutput(featureFeed);

  onProgress(0.92, 'Writing FreeSurfer surfaces and QC image…');
  const [facesLeftBytes, facesRightBytes] = await Promise.all([
    loadAsset('faces-lh.i32', 0.91, 0.92),
    loadAsset('faces-rh.i32', 0.92, 0.93),
  ]);
  const faces = {
    lh: readInt32Asset(facesLeftBytes),
    rh: readInt32Asset(facesRightBytes),
  };
  const files = [];
  for (const hemisphere of ['lh', 'rh']) {
    for (const surface of ['white', 'pial', 'registration']) {
      const name = `${hemisphere}.${surface}`;
      files.push({
        id: name.replace('.', '-'),
        name,
        mediaType: 'application/vnd.freesurfer.surface',
        bytes: writeFreeSurfer(vertices[name], faces[hemisphere]),
      });
    }
  }
  const outputSha256 = Object.fromEntries(
    await Promise.all(files.map(async (file) => [file.name, await sha256(file.bytes)])),
  );
  const qc = createQcVolume(source, vertices, overlayThickness);
  files.unshift({ id: 'qc', name: 'topofit_qc.nii', mediaType: 'application/nifti', bytes: qc });
  outputSha256['topofit_qc.nii'] = await sha256(qc);
  const provenance = {
    schemaVersion: 2,
    status: 'SURFACE_READY_RESEARCH_ONLY',
    warning: 'RESEARCH ONLY - NOT MOTION-CLEARED - NOT FOR PRESCRIPTION',
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
    runtime,
  };
  files.push({
    id: 'provenance',
    name: 'topofit_manifest.json',
    mediaType: 'application/json',
    bytes: encoder.encode(`${JSON.stringify(provenance, null, 2)}\n`).buffer,
  });
  onProgress(1, 'Cortical surfaces ready');
  return { files, provenance, elapsedSeconds: (performance.now() - started) / 1000 };
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
