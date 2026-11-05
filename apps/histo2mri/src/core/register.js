// Registration of one histology section to its MRI plane with Greedy (NMI): orientation, rigid,
// affine, an optional search of the plane's offset and tilt, then a deformable warp.
//
// Greedy is 3-D, so the section is registered in the plane's local frame: the fixed image is the
// MRI sampled on the plane, the moving image is the section repeated on three slices 1 m apart,
// so it has no gradient across the plane, and each linear result keeps only its in-plane terms
// (matrix.js `inPlane`). The linear stages take a one-slice fixed image. Greedy's NMI gradient
// samples the slice beyond a one-slice image, and that across-plane term dominates the
// normalised deformable update, so the deformable stage takes the fixed slice repeated three
// times with a mask on the middle one, at full resolution only (a 3-slice image has no coarser
// level that keeps the mask): there the across-plane gradient is zero. Greedy is injected
// (`greedy.rigid`, `.affine`, `.svf`, async) so the browser worker and Node tests run the same
// pipeline.
import { blockAverage, bilinear, foreground, maskMoments } from './image2d.js';
import { toContrast } from './colour.js';
import { nmi } from './nmi.js';
import { apply, formatMatrix, identity, inPlane, inPlaneRigid, invert, multiply, parseMatrix } from './matrix.js';
import { samplePlane, slicePlane } from './plane.js';
import { readWarp, scalarNifti } from './nifti.js';

/** Slab thickness of the moving image along the normal (mm); 3 slices this far apart. */
export const SLAB_SPACING = 1000;

export const DEFAULTS = Object.freeze({
  contrast: 'auto',
  orientation: 'auto',
  pixelSize: null,
  refinePlane: true,
  searchOffset: 2,
  searchTilt: 4,
  deformable: true,
  linearIterations: '100x50x10',
  deformableIterations: '0x0x200',
});

/** The eight in-plane orientations: rotation by k × 90° after an optional horizontal flip. */
export const ORIENTATIONS = Array.from({ length: 8 }, (_, k) => ({ id: k, rotation: (k % 4) * 90, flip: k >= 4 }));

/** Plane search rounds (search, then affine refit) before the best plane must have repeated. */
const MAX_SEARCH_ROUNDS = 4;

/** Longest side of the image the tissue moments are measured on. */
const ANALYSIS_SIZE = 1024;

/** Working memory one section's registration and its output files may take (bytes). */
export const MAX_WORKING_BYTES = 2 * 1024 ** 3;

// Estimated bytes per pixel of each grid a registration allocates, rounded up.
// Plane pixel: the fixed image, its tissue mask and NIfTI, the search's samples (~20 B); the
// deformable stage's three-slice fixed slab and mask with their NIfTI copies (48 B); Greedy's
// vector fields on that slab (~8 fields × 3 slices × 3 components × 4 B = 288 B); the warp as
// returned, read and kept, and the world warp and plane files (~100 B).
const PLANE_PIXEL_BYTES = 456;
// Working (moving) pixel: the block average (float64 sums, counts, float32 planes: 12 B per
// channel + 4), contrast and tissue (~10 B), the three-slice moving slab, its NIfTI and Greedy's
// copy (36 B), the section output image (~14 B).
const workingPixelBytes = (channels) => 12 * channels + 64;
// Output pixel: the warped RGBA, its mask and one resliced channel at a time (~14 B), and its
// float copies when the sections are drawn into the MRI grid (16 B).
const OUTPUT_PIXEL_BYTES = 32;

function abortable(signal) {
  signal?.throwIfAborted();
}

/** 2-D affine (local mm from moving pixel) of an orientation, scale and the two tissue centroids. */
export function initialPlacement({ orientation, spacing, pixelCentroid, localCentroid }) {
  const angle = (orientation.rotation * Math.PI) / 180;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const f = orientation.flip ? -1 : 1;
  const a = [[spacing * c * f, -spacing * s], [spacing * s * f, spacing * c]];
  const t = [
    localCentroid[0] - (a[0][0] * pixelCentroid[0] + a[0][1] * pixelCentroid[1]),
    localCentroid[1] - (a[1][0] * pixelCentroid[0] + a[1][1] * pixelCentroid[1]),
  ];
  return [[a[0][0], a[0][1], 0, t[0]], [a[1][0], a[1][1], 0, t[1]], [0, 0, 1, 0], [0, 0, 0, 1]];
}

/** The fixed image (MRI on the plane) as raw NIfTI bytes in the local frame. */
function fixedNifti(image, plane) {
  const sform = [[plane.spacing, 0, 0, 0], [0, plane.spacing, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
  return scalarNifti(image, [plane.nu, plane.nv, 1], sform);
}

/** `image` on three slices of the moving slab's spacing, centred on the plane. */
function fixedSlab(image, plane) {
  const sform = [[plane.spacing, 0, 0, 0], [0, plane.spacing, 0, 0], [0, 0, SLAB_SPACING, -SLAB_SPACING], [0, 0, 0, 1]];
  const slab = new Float32Array(image.length * 3);
  for (let k = 0; k < 3; k++) slab.set(image, k * image.length);
  return scalarNifti(slab, [plane.nu, plane.nv, 3], sform);
}

/** The deformable stage's fixed slab and its mask (the middle slice). */
function deformableInputs(image, plane) {
  const mask = new Float32Array(image.length * 3);
  mask.fill(1, image.length, 2 * image.length);
  const sform = [[plane.spacing, 0, 0, 0], [0, plane.spacing, 0, 0], [0, 0, SLAB_SPACING, -SLAB_SPACING], [0, 0, 0, 1]];
  return { fixed: fixedSlab(image, plane), mask: scalarNifti(mask, [plane.nu, plane.nv, 3], sform) };
}

/** The moving section as a three-slice slab in the local frame (`placement`: local mm from pixel). */
function movingNifti(moving, placement) {
  const slab = new Float32Array(moving.data.length * 3);
  for (let k = 0; k < 3; k++) slab.set(moving.data, k * moving.data.length);
  const sform = placement.map((row) => [...row]);
  sform[2] = [0, 0, SLAB_SPACING, -SLAB_SPACING];
  return scalarNifti(slab, [moving.width, moving.height, 3], sform);
}

/**
 * Samples a moving 2-D image onto the plane grid through `matrix` (local fixed → local moving)
 * and an optional displacement field (on the fixed grid, LPS mm, acting before the matrix as in
 * Greedy). Returns the values and a mask of the pixels that land inside the moving image.
 */
export function resliceLocal({ grid, image, width, height, placement, matrix, warp = null, factor = 1, outside = 0 }) {
  const toPixel = multiply(invert(placement), matrix);
  const nu = (grid.nu - 1) * factor + 1;
  const nv = (grid.nv - 1) * factor + 1;
  const step = grid.spacing / factor;
  const values = new Float32Array(nu * nv);
  const inside = new Uint8Array(nu * nv);
  const plane = grid.nu * grid.nv;
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      let x = i * step;
      let y = j * step;
      if (warp) {
        // Greedy's field is in LPS: x and y are negated relative to the local (RAS-like) frame.
        x -= bilinear(warp, grid.nu, grid.nv, i / factor, j / factor);
        y -= bilinear(warp.subarray(plane), grid.nu, grid.nv, i / factor, j / factor);
      }
      const px = toPixel[0][0] * x + toPixel[0][1] * y + toPixel[0][3];
      const py = toPixel[1][0] * x + toPixel[1][1] * y + toPixel[1][3];
      const k = j * nu + i;
      if (px >= 0 && py >= 0 && px <= width - 1 && py <= height - 1) {
        values[k] = bilinear(image, width, height, px, py);
        inside[k] = 1;
      } else {
        values[k] = outside;
      }
    }
  }
  return { values, inside, nu, nv, spacing: step };
}

/** Moving-image block size for a target pixel spacing, from the full-resolution spacing. */
function blockFor(target, fullSpacing) {
  return Math.max(1, Math.round(target / fullSpacing));
}

const megabytes = (bytes) => `${Math.round(bytes / 1024 ** 2)} MB`;

/**
 * Estimated working memory (bytes) of registering `section` ({ width, height, channels }) on
 * `plane` and writing its outputs, from the grid sizes alone. Without `fullSpacing` (mm) the
 * section's part is the tissue analysis image only.
 */
export function workingMemory(plane, section, fullSpacing = null) {
  const planePixels = plane.nu * plane.nv;
  const blocked = (block) => Math.ceil(section.width / block) * Math.ceil(section.height / block);
  const analysisBlock = Math.max(1, Math.ceil(Math.max(section.width, section.height) / ANALYSIS_SIZE));
  let sectionBytes = blocked(analysisBlock) * workingPixelBytes(section.channels);
  if (fullSpacing) {
    const factor = Math.max(1, Math.min(4, Math.round(plane.spacing / fullSpacing)));
    const outputPixels = ((plane.nu - 1) * factor + 1) * ((plane.nv - 1) * factor + 1);
    const outputBlock = blockFor(plane.spacing / factor, fullSpacing);
    sectionBytes += blocked(blockFor(plane.spacing, fullSpacing)) * workingPixelBytes(section.channels)
      + blocked(outputBlock) * workingPixelBytes(section.channels)
      + outputPixels * OUTPUT_PIXEL_BYTES;
  }
  return planePixels * PLANE_PIXEL_BYTES + sectionBytes;
}

/** Refuses a registration whose estimated working memory is above `maxBytes`, before allocating it. */
function assertWorkingMemory(plane, section, fullSpacing, maxBytes) {
  const bytes = workingMemory(plane, section, fullSpacing);
  if (bytes <= maxBytes) return;
  const pixel = fullSpacing ? ` at ${Number((fullSpacing * 1000).toPrecision(3))} µm per pixel` : '';
  throw new Error(`This registration needs about ${megabytes(bytes)} of working memory, above the ${megabytes(maxBytes)} limit (MRI plane ${plane.nu} × ${plane.nv} pixels of ${Number(plane.spacing.toPrecision(3))} mm, section ${section.width} × ${section.height} pixels${pixel}). Use a coarser MRI or section, or a larger section pixel size.`);
}

/**
 * The plane, the MRI on it and the section's full-resolution pixel size (mm), each memory check
 * made before the arrays it covers are allocated.
 */
function measureSection({ volume, section, start, settings, maxBytes, onProgress }) {
  onProgress('Sampling the MRI on the section plane', 0.02);
  const plane = slicePlane(volume, start);
  const givenSpacing = settings.pixelSize ? settings.pixelSize / 1000 : null;
  assertWorkingMemory(plane, section, givenSpacing, maxBytes);
  const fixed = samplePlane(volume, plane);
  const fixedTissue = foreground(fixed);
  const fixedMoments = maskMoments(fixedTissue, plane.nu, plane.nv);

  onProgress('Measuring the section', 0.05);
  const analysisBlock = Math.max(1, Math.ceil(Math.max(section.width, section.height) / ANALYSIS_SIZE));
  const analysis = blockAverage(section, analysisBlock);
  // Pixel size (mm) of the full-resolution section: given, or the size at which the section's
  // tissue area equals the MRI slice's.
  let fullSpacing = givenSpacing;
  if (!fullSpacing) {
    const analysisContrast = toContrast(analysis.planes, analysis.width, analysis.height, settings.contrast);
    const tissue = maskMoments(foreground(analysisContrast.data), analysis.width, analysis.height);
    fullSpacing = (plane.spacing * Math.sqrt(fixedMoments.area / tissue.area)) / analysisBlock;
    if (!(fullSpacing > 0) || !Number.isFinite(fullSpacing)) throw new Error('The section pixel size could not be estimated.');
    assertWorkingMemory(plane, section, fullSpacing, maxBytes);
  }
  return { plane, fixed, fixedTissue, fixedMoments, analysis, analysisBlock, fullSpacing };
}

/**
 * Checks, before any registration starts, that a section fits the working-memory limit; it
 * measures the section (and samples the MRI plane) as registerSection does. Throws if it does not.
 */
export function preflightSection({ volume, section, plane, options = {}, maxBytes = MAX_WORKING_BYTES }) {
  measureSection({ volume, section, start: plane, settings: { ...DEFAULTS, ...options }, maxBytes, onProgress: () => {} });
}

/**
 * Registers one section. `volume` is { dims, affine, data } (MRI, x fastest), `section`
 * { width, height, channels, data, maxValue, pixelSize } (interleaved, as read). `plane` is
 * { axis, index, offset?, tilt? }. Returns the transforms in the plane's local frame and what
 * the outputs need; outputs.js turns them into files. Refuses, before allocating them, grids
 * whose estimated working memory (workingMemory) is above `maxBytes`.
 */
export async function registerSection({ volume, section, plane: start, options = {}, greedy, onProgress = () => {}, signal, maxBytes = MAX_WORKING_BYTES }) {
  const settings = { ...DEFAULTS, ...options };
  abortable(signal);
  const measured = measureSection({ volume, section, start, settings, maxBytes, onProgress });
  let { plane, fixed } = measured;
  const { fixedTissue, fixedMoments, analysis, analysisBlock, fullSpacing } = measured;
  const block = blockFor(plane.spacing, fullSpacing);
  const working = block === analysisBlock ? analysis : blockAverage(section, block);
  abortable(signal);
  const contrast = toContrast(working.planes, working.width, working.height, settings.contrast);
  const moving = { data: contrast.data, width: working.width, height: working.height, spacing: fullSpacing * block, block };
  const movingMoments = maskMoments(foreground(moving.data), moving.width, moving.height);
  const movingBytes = (placement) => movingNifti(moving, placement);
  const fixedLocalCentroid = [fixedMoments.cx * plane.spacing, fixedMoments.cy * plane.spacing];

  // NMI over the whole plane, the section's outside counted as background (its contrast is near 0
  // there): scoring only the overlap would favour placements that overlap the MRI a little.
  const score = (matrix, placement, warp = null, image = fixed) => {
    const moved = resliceLocal({ grid: plane, image: moving.data, width: moving.width, height: moving.height, placement, matrix, warp });
    return { value: nmi(image, moved.values), moved };
  };

  // Orientation: a rigid registration from each candidate start, the best NMI wins.
  const candidates = settings.orientation === 'auto' ? ORIENTATIONS : [ORIENTATIONS[Number(settings.orientation)]];
  if (candidates.some((candidate) => !candidate)) throw new Error('Unknown orientation.');
  let best = null;
  const fixedBytes = fixedNifti(fixed, plane);
  for (const [n, orientation] of candidates.entries()) {
    abortable(signal);
    onProgress(`Rigid registration, orientation ${n + 1} of ${candidates.length}`, 0.08 + (0.3 * n) / candidates.length);
    const placement = initialPlacement({ orientation, spacing: moving.spacing, pixelCentroid: [movingMoments.cx, movingMoments.cy], localCentroid: fixedLocalCentroid });
    const text = await greedy.rigid({ fixed: fixedBytes, moving: movingBytes(placement), iterations: settings.linearIterations });
    const rigid = inPlaneRigid(parseMatrix(text));
    const { value } = score(rigid, placement);
    if (!best || value > best.nmi) best = { orientation, placement, rigid, nmi: value };
  }
  abortable(signal);
  const { orientation, placement } = best;
  const initialNmi = score(identity(), placement).value;
  onProgress('Affine registration', 0.4);
  const movingSlab = movingBytes(placement);
  let affine = inPlane(parseMatrix(await greedy.affine({ fixed: fixedBytes, moving: movingSlab, iterations: settings.linearIterations, initial: formatMatrix(best.rigid) })));
  const affineNmi = score(affine, placement).value;

  // The plane search alternates with the affine: each round scores every candidate plane with
  // the section moved by the current affine, then refits the affine on the best plane, until
  // the best plane repeats (an affine fitted on a wrong plane absorbs part of the difference).
  let search = null;
  if (settings.refinePlane) {
    const grid = { nu: plane.nu, nv: plane.nv, spacing: plane.spacing };
    const offsets = [];
    for (let o = -settings.searchOffset; o <= settings.searchOffset + 1e-9; o += 0.5) offsets.push(o);
    const tilts = [];
    for (let t = -settings.searchTilt; t <= settings.searchTilt + 1e-9; t += 1) tilts.push(t);
    const startScore = affineNmi;
    let current = { offsetSlices: 0, tilt: [0, 0], score: startScore };
    for (let round = 0; round < MAX_SEARCH_ROUNDS; round++) {
      abortable(signal);
      onProgress(`Searching the plane offset and tilt (round ${round + 1})`, 0.5 + 0.06 * round);
      const moved = resliceLocal({ grid: plane, image: moving.data, width: moving.width, height: moving.height, placement, matrix: affine });
      let winner = null;
      for (const o of offsets) {
        abortable(signal);
        for (const a of tilts) {
          for (const b of tilts) {
            const candidate = slicePlane(volume, { ...start, offset: (start.offset ?? 0) + o * plane.sliceThickness, tilt: [(start.tilt?.[0] ?? 0) + a, (start.tilt?.[1] ?? 0) + b], grid });
            const value = nmi(samplePlane(volume, candidate, moved.inside), moved.values, moved.inside);
            if (!winner || value > winner.nmi) winner = { offsetSlices: o, tilt: [a, b], nmi: value, candidate };
          }
        }
      }
      if (winner.offsetSlices === current.offsetSlices && winner.tilt[0] === current.tilt[0] && winner.tilt[1] === current.tilt[1]) break;
      onProgress('Affine registration on the refined plane', 0.53 + 0.06 * round);
      const image = samplePlane(volume, winner.candidate);
      const refit = inPlane(parseMatrix(await greedy.affine({ fixed: fixedNifti(image, winner.candidate), moving: movingSlab, iterations: settings.linearIterations, initial: formatMatrix(affine) })));
      // Keep the new plane only if its refitted affine scores better over the whole plane.
      const refitScore = score(refit, placement, null, image).value;
      if (!(refitScore > current.score)) break;
      current = { ...winner, score: refitScore };
      plane = winner.candidate;
      fixed = image;
      affine = refit;
    }
    search = { offsetSlices: current.offsetSlices, tilt: current.tilt, nmi: current.score, startNmi: startScore, candidates: offsets.length * tilts.length ** 2 };
  }

  let warp = null;
  let warpHeader = null;
  if (settings.deformable) {
    abortable(signal);
    onProgress('Deformable registration', 0.75);
    const inputs = deformableInputs(fixed, plane);
    const field = readWarp(await greedy.svf({ ...inputs, moving: movingSlab, matrix: formatMatrix(affine), metric: 'NMI', iterations: settings.deformableIterations }));
    // The middle slice's in-plane components; the component along the normal is zero there.
    const pixels = plane.nu * plane.nv;
    warp = new Float32Array(3 * pixels);
    for (let c = 0; c < 2; c++) warp.set(field.data.subarray(c * field.voxels + pixels, c * field.voxels + 2 * pixels), c * pixels);
    warpHeader = field.header;
  }
  abortable(signal);
  const linearScore = score(affine, placement).value;
  let final = score(affine, placement, warp);
  // A warp that lowers NMI over the plane is not kept (small or featureless images).
  const warpRejected = Boolean(warp) && !(final.value > linearScore);
  if (warpRejected) {
    warp = null;
    warpHeader = null;
    final = { value: linearScore };
  }
  onProgress('Registration complete', 0.9);
  return {
    plane,
    initialPlane: measured.plane,
    start,
    fixed,
    fixedTissue,
    moving,
    contrastInverted: contrast.inverted,
    placement,
    orientation,
    fullSpacing,
    rigid: best.rigid,
    affine,
    warp,
    warpHeader,
    nmi: { initial: initialNmi, rigid: best.nmi, affine: linearScore, final: final.value },
    warpRejected,
    search,
  };
}

/**
 * The registration as it stood after each stage, for scoring: `start` (the initial placement on
 * the requested plane), `rigid`, `affine` (the linear result, on the searched plane when the
 * search ran) and `final` (with the warp). Each can stand for `result` in sectionPixelAt.
 */
export function registrationStages(result) {
  return {
    start: { ...result, plane: result.initialPlane, affine: identity(), warp: null },
    rigid: { ...result, plane: result.initialPlane, affine: result.rigid, warp: null },
    affine: { ...result, warp: null },
    final: result,
  };
}

/**
 * Where a world point (RAS mm) of the MRI lands in the section, through the registration:
 * the point is projected onto the plane, displaced by the warp and mapped by the affine.
 * Returns full-resolution section pixel coordinates and the point's distance from the plane.
 */
export function sectionPixelAt(result, world) {
  const { plane, warp, affine, placement, moving } = result;
  const [x0, y0, distance] = apply(invert(plane.frame), world);
  let x = x0;
  let y = y0;
  if (warp) {
    const voxels = plane.nu * plane.nv;
    const i = x0 / plane.spacing;
    const j = y0 / plane.spacing;
    x -= bilinear(warp, plane.nu, plane.nv, i, j);
    y -= bilinear(warp.subarray(voxels), plane.nu, plane.nv, i, j);
  }
  const [px, py] = apply(multiply(invert(placement), affine), [x, y, 0]);
  // Working pixel i is the mean of full-resolution pixels i·block … i·block + block − 1.
  const centre = (moving.block - 1) / 2;
  return { x: px * moving.block + centre, y: py * moving.block + centre, distance };
}
