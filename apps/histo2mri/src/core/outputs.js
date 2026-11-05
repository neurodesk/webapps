// Files from a registration: the section warped onto the MRI plane, the sections placed in the
// MRI grid, and Greedy-compatible files in world (RAS) coordinates:
//   greedy -d 3 -rf <plane>.nii.gz -rm <section>.nii.gz <out>.nii.gz -r <warp>.nii.gz <affine>.mat
// reproduces the section on the plane (test/outputs.test.js runs it).
import { blockAverage, bilinear, foreground } from './image2d.js';
import { applyLinear, formatMatrix, invert, multiply } from './matrix.js';
import { placeOnPlane } from './plane.js';
import { resliceLocal } from './register.js';
import { rgbaNifti, scalarNifti, warpNifti } from './nifti.js';

/** Output pixels per plane pixel: up to 4, and no finer than the section itself. */
export function outputFactor(result) {
  return Math.max(1, Math.min(4, Math.round(result.plane.spacing / result.fullSpacing)));
}

function localSform(spacing) {
  return [[spacing, 0, 0, 0], [0, spacing, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
}

/** The 99.5th percentile of an image's brightest channel, for an 8-bit display scale. */
function displayMaximum(planes) {
  const n = planes[0].length;
  const stride = Math.max(1, Math.floor(n / 200000));
  const values = [];
  for (let i = 0; i < n; i += stride) values.push(Math.max(...planes.map((plane) => plane[i])));
  values.sort((a, b) => a - b);
  return values[Math.floor(0.995 * (values.length - 1))] || 1;
}

/**
 * The section in colour on the plane grid refined `factor` times, as RGBA: alpha is 255 where the
 * warped tissue mask is set. Returns the bytes and the grid ({ nu, nv, spacing }).
 */
export function warpedSection(result, section) {
  const factor = outputFactor(result);
  const spacing = result.plane.spacing / factor;
  const block = Math.max(1, Math.round(spacing / result.fullSpacing));
  const colour = blockAverage(section, block);
  const shift = ((block - 1) / 2 - (result.moving.block - 1) / 2) / result.moving.block;
  // Output-resolution pixel → working pixel, then the working placement.
  const toWorking = [[block / result.moving.block, 0, 0, shift], [0, block / result.moving.block, 0, shift], [0, 0, 1, 0], [0, 0, 0, 1]];
  const placement = multiply(result.placement, toWorking);
  const tissue = Float32Array.from(foreground(result.moving.data));
  const mask = resliceLocal({ grid: result.plane, image: tissue, width: result.moving.width, height: result.moving.height, placement: result.placement, matrix: result.affine, warp: result.warp, factor });
  const maximum = displayMaximum(colour.planes);
  const channels = colour.planes.length === 1 ? [colour.planes[0], colour.planes[0], colour.planes[0]] : colour.planes;
  const rgba = new Uint8Array(mask.values.length * 4);
  for (let c = 0; c < 3; c++) {
    const moved = resliceLocal({ grid: result.plane, image: channels[c], width: colour.width, height: colour.height, placement, matrix: result.affine, warp: result.warp, factor });
    for (let i = 0; i < moved.values.length; i++) rgba[4 * i + c] = Math.round(Math.min(1, moved.values[i] / maximum) * 255);
  }
  for (let i = 0; i < mask.values.length; i++) rgba[4 * i + 3] = mask.values[i] >= 0.5 ? 255 : 0;
  return { rgba, nu: mask.nu, nv: mask.nv, spacing };
}

/** Voxel-to-world sform of a grid on the plane with `spacing` (mm). */
export function planeSform(plane, spacing) {
  return multiply(plane.frame, localSform(spacing));
}

/** Greedy's affine (RAS, fixed point to moving point) in world coordinates. */
export function worldMatrix(result) {
  return multiply(multiply(result.plane.frame, result.affine), invert(result.plane.frame));
}

/** Greedy's affine and warp in world coordinates, on the plane image's grid. */
export function worldTransforms(result) {
  const { plane, warp } = result;
  const matrix = worldMatrix(result);
  const pixels = plane.nu * plane.nv;
  const components = new Float32Array(3 * pixels);
  if (warp) {
    for (let i = 0; i < pixels; i++) {
      // Local LPS → local RAS (x and y negated), into world RAS, then world LPS.
      const world = applyLinear(plane.frame, [-warp[i], -warp[pixels + i], 0]);
      components[i] = -world[0];
      components[pixels + i] = -world[1];
      components[2 * pixels + i] = world[2];
    }
  }
  return {
    matrix: formatMatrix(matrix),
    warp: warpNifti(components, [plane.nu, plane.nv, 1], planeSform(plane, plane.spacing)),
  };
}

/** The MRI on the plane and the registered section contrast, both in world coordinates. */
export function registrationImages(result) {
  const { plane, fixed, moving, placement } = result;
  return {
    plane: scalarNifti(fixed, [plane.nu, plane.nv, 1], planeSform(plane, plane.spacing)),
    section: scalarNifti(moving.data, [moving.width, moving.height, 1], multiply(plane.frame, placement)),
  };
}

/**
 * Every registered section drawn into the MRI's grid as RGBA (alpha 0 elsewhere). `items` are
 * { result, warped } with `warped` from warpedSection. Refuses a grid above `maxBytes`.
 */
export function sectionsInVolume(volume, items, maxBytes = 1024 ** 3) {
  const voxels = volume.dims[0] * volume.dims[1] * volume.dims[2];
  if (voxels * 4 > maxBytes) throw new Error(`The MRI grid is too large for a colour copy (${Math.round((voxels * 4) / 1024 ** 2)} MB).`);
  const rgba = new Uint8Array(voxels * 4);
  let written = 0;
  for (const { result, warped } of items) {
    const { nu, nv, spacing } = warped;
    const alpha = new Float32Array(nu * nv);
    const channels = [0, 1, 2].map(() => new Float32Array(nu * nv));
    for (let i = 0; i < nu * nv; i++) {
      alpha[i] = warped.rgba[4 * i + 3];
      for (let c = 0; c < 3; c++) channels[c][i] = warped.rgba[4 * i + c];
    }
    written += placeOnPlane(volume, result.plane, (x, y) => {
      const i = x / spacing;
      const j = y / spacing;
      if (bilinear(alpha, nu, nv, i, j) < 127.5) return null;
      return channels.map((channel) => Math.round(bilinear(channel, nu, nv, i, j)));
    }, (index, value) => {
      rgba.set([value[0], value[1], value[2], 255], 4 * index);
    });
  }
  return { bytes: rgbaNifti(rgba, volume.dims, volume.affine), written };
}

/** The registration's parameters and scores, for the report download. */
export function registrationReport(result, { name, version, settings, axisName }) {
  const { plane, start, orientation, nmi, search, fullSpacing, moving } = result;
  return {
    app: 'histo2mri',
    version,
    section: name,
    plane: {
      axis: plane.axis,
      axisName,
      index: plane.index,
      offsetMm: plane.offset,
      tiltDegrees: plane.tilt,
      requested: { index: start.index, offsetMm: start.offset ?? 0, tiltDegrees: start.tilt ?? [0, 0] },
      gridSpacingMm: plane.spacing,
    },
    orientation: { rotationDegrees: orientation.rotation, flipped: orientation.flip },
    sectionPixelSizeMm: fullSpacing,
    workingPixelSizeMm: moving.spacing,
    contrastInverted: result.contrastInverted,
    nmi,
    deformableRejected: result.warpRejected,
    planeSearch: search,
    affineLocal: result.affine,
    affineWorld: worldMatrix(result),
    settings,
  };
}
