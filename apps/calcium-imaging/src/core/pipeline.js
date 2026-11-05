// The analysis after motion correction, shared by the worker and the Node tests: summary
// images, ROIs (detected or given), neuropil-corrected ΔF/F and AR(1) deconvolution.
import { meanMaxImages, localCorrelationImage } from './images.js';
import { detectRois } from './rois.js';
import { roiPixels, neuropilMasks, meanTraces, deltaFOverF } from './traces.js';
import { deconvolve } from './oasis.js';
import { createRegistration, initialTemplate } from './registration.js';

export const DEFAULTS = Object.freeze({
  motion: 'rigid',
  maxShift: 10,
  upsample: 10,
  normalization: 'none',
  templatePasses: 2,
  patchSize: 64,
  patchOverlap: 32,
  maxDeviation: 3,
  diameter: 10,
  seedZ: 4,
  neuropilCoefficient: 0.7,
  baselineWindow: 60,
  baselinePercentile: 8,
  deconvolution: true,
});

/** Registers frames [start, end) of `movie` into `out`; returns their shifts and the frames' sum. */
export function registerRange(movie, out, template, { width, height, start, end }, options, onFrame) {
  const plane = width * height;
  const registration = createRegistration(template, height, width, { ...options, mode: options.motion });
  const shifts = [];
  const patches = [];
  const sum = new Float64Array(plane);
  for (let f = start; f < end; f++) {
    const frame = movie.subarray(f * plane, (f + 1) * plane);
    const target = out.subarray(f * plane, (f + 1) * plane);
    if (options.motion === 'none') {
      target.set(frame);
      shifts.push([0, 0]);
    } else {
      const result = registration.correct(frame, target);
      shifts.push(result.rigid);
      if (result.patches) patches.push(result.patches);
    }
    for (let i = 0; i < plane; i++) sum[i] += target[i];
    onFrame?.(f);
  }
  return { shifts, patches: patches.length ? patches : null, sum, grid: registration.grid };
}

/**
 * Whole-movie motion correction in one thread (the worker pool shards the same steps).
 * Passes before the last are rigid and only refine the template (the mean of the registered
 * frames); the last pass uses the chosen mode.
 */
export function motionCorrect(movie, { width, height, frames }, options = DEFAULTS) {
  const plane = width * height;
  const out = new Float32Array(movie.length);
  let template = initialTemplate(movie, frames, height, width);
  const passes = options.motion === 'none' ? 1 : Math.max(1, options.templatePasses);
  let result = null;
  for (let pass = 1; pass <= passes; pass++) {
    const motion = pass < passes ? 'rigid' : options.motion;
    result = registerRange(movie, out, template, { width, height, start: 0, end: frames }, { ...options, motion });
    if (pass < passes) template = Float64Array.from(result.sum, (value) => value / frames);
  }
  return { registered: out, template, ...result, plane };
}

/** The border band (pixels) that resampling filled from the edge: ⌈largest |shift|⌉ + 1, or 0. */
export function borderMargin(shifts, patches = null) {
  let largest = 0;
  for (const shift of shifts) largest = Math.max(largest, Math.abs(shift[0]), Math.abs(shift[1]));
  for (const frame of patches ?? []) for (const shift of frame) largest = Math.max(largest, Math.abs(shift[0]), Math.abs(shift[1]));
  return largest > 0 ? Math.ceil(largest) + 1 : 0;
}

/** Summary images, ROIs, traces and deconvolution of a registered movie. */
export function analyse(registered, { width, height, frames, frameRate }, options = DEFAULTS, labels = null, { margin = 0 } = {}) {
  const plane = width * height;
  const { mean, max } = meanMaxImages(registered, frames, plane);
  const correlation = localCorrelationImage(registered, frames, height, width);
  const detection = labels ? null : detectRois(correlation, height, width, { z: options.seedZ, diameter: options.diameter, margin });
  const roiLabels = labels ?? detection.labels;
  return { mean, max, correlation, detection, ...extractActivity(registered, { width, height, frames, frameRate }, options, roiLabels) };
}

/** Traces and deconvolution for a label image (used again after ROI edits). */
export function extractActivity(registered, { width, height, frames, frameRate }, options, labels) {
  const plane = width * height;
  const rois = roiPixels(labels);
  const neuropil = neuropilMasks(labels, height, width, rois, { innerGap: 2, minPixels: 200, maxRadius: Math.max(20, Math.round(5 * options.diameter)) });
  const F = meanTraces(registered, frames, plane, rois);
  const Fneu = meanTraces(registered, frames, plane, neuropil);
  const window = Math.max(3, Math.min(frames, Math.round(options.baselineWindow * frameRate)));
  const cells = rois.map((pixels, k) => {
    const trace = deltaFOverF(F[k], Fneu[k], { coefficient: options.neuropilCoefficient, window, percentile: options.baselinePercentile });
    let centroidY = 0;
    let centroidX = 0;
    for (const i of pixels) {
      centroidY += Math.floor(i / width);
      centroidX += i % width;
    }
    const cell = {
      id: k + 1,
      area: pixels.length,
      neuropilPixels: neuropil[k].length,
      centroid: [centroidY / pixels.length, centroidX / pixels.length],
      F: F[k],
      Fneu: Fneu[k],
      ...trace,
      deconvolution: null,
    };
    if (options.deconvolution && trace.undefinedSamples === 0) cell.deconvolution = deconvolve(trace.dff);
    return cell;
  });
  return { labels, cells, baselineWindowFrames: window };
}
