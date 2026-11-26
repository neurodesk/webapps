// Analytical 3D synthetic vessel phantoms for offline unit testing,
// CLI self-check, and external oracle validation.
import { writeNiftiVolume } from '@neurodesk/webapp-components/file-io/nifti-volume';
import { inspectAffine } from './volume.js';

function makeOrthoAffine(spacing, origin = [0, 0, 0]) {
  return [
    [spacing[0], 0, 0, origin[0]],
    [0, spacing[1], 0, origin[1]],
    [0, 0, spacing[2], origin[2]],
    [0, 0, 0, 1],
  ];
}

function distPointToSegment3(px, py, pz, ax, ay, az, bx, by, bz) {
  const abx = bx - ax;
  const aby = by - ay;
  const abz = bz - az;
  const lenSq = abx * abx + aby * aby + abz * abz;
  let t = 0;
  if (lenSq > 1e-12) {
    t = ((px - ax) * abx + (py - ay) * aby + (pz - az) * abz) / lenSq;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
  }
  const cx = ax + t * abx;
  const cy = ay + t * aby;
  const cz = az + t * abz;
  return Math.hypot(px - cx, py - cy, pz - cz);
}

function paintCapsule(mask, dims, spacing, aMm, bMm, radiusMm) {
  const [nx, ny, nz] = dims;
  const [sx, sy, sz] = spacing;
  const slice = nx * ny;
  for (let z = 0; z < nz; z += 1) {
    const pz = z * sz;
    for (let y = 0; y < ny; y += 1) {
      const py = y * sy;
      const row = z * slice + y * nx;
      for (let x = 0; x < nx; x += 1) {
        const px = x * sx;
        if (distPointToSegment3(px, py, pz, aMm[0], aMm[1], aMm[2], bMm[0], bMm[1], bMm[2]) <= radiusMm) {
          mask[row + x] = 1;
        }
      }
    }
  }
}

export function packPhantomNifti(mask, dims, spacing = [0.5, 0.5, 0.5]) {
  const affine = makeOrthoAffine(spacing);
  return new Uint8Array(
    writeNiftiVolume({
      data: mask,
      dims,
      affine,
      datatype: 'uint8',
      description: 'VesselCharter synthetic analytical phantom',
    }),
  );
}

/**
 * Straight cylinder of known physical length and radius, optionally oblique and anisotropic.
 */
export function cylinderPhantom({
  dims = [48, 48, 48],
  spacing = [0.5, 0.5, 0.5],
  radiusMm = 2.0,
  startMm = [12, 12, 6],
  endMm = [12, 12, 18],
} = {}) {
  const mask = new Uint8Array(dims[0] * dims[1] * dims[2]);
  paintCapsule(mask, dims, spacing, startMm, endMm, radiusMm);
  const affine = makeOrthoAffine(spacing);
  const trueLengthMm = Math.hypot(
    endMm[0] - startMm[0],
    endMm[1] - startMm[1],
    endMm[2] - startMm[2],
  );
  return {
    mask,
    dims,
    spatial: inspectAffine(affine, 2),
    groundTruth: {
      diameterMm: 2 * radiusMm,
      lengthMm: trueLengthMm,
      segmentCount: 1,
      junctionCount: 0,
      endpointCount: 2,
      cycleRankBetti1: 0,
    },
  };
}

/**
 * Exact 1-voxel or 2-voxel wide axis-aligned tube on an anisotropic grid.
 */
export function thinTubePhantom({
  widthVox = 1,
  lengthVox = 24,
  spacing = [0.46875, 0.46875, 0.7],
} = {}) {
  const dims = [16, 16, lengthVox + 8];
  const mask = new Uint8Array(dims[0] * dims[1] * dims[2]);
  const [nx, ny] = dims;
  const slice = nx * ny;
  for (let z = 4; z < 4 + lengthVox; z += 1) {
    for (let dy = 0; dy < widthVox; dy += 1) {
      for (let dx = 0; dx < widthVox; dx += 1) {
        mask[z * slice + (7 + dy) * nx + (7 + dx)] = 1;
      }
    }
  }
  const affine = makeOrthoAffine(spacing);
  return {
    mask,
    dims,
    spatial: inspectAffine(affine, 2),
    groundTruth: {
      widthMm: widthVox * spacing[0],
      lengthMm: (lengthVox - 1) * spacing[2],
    },
  };
}

/**
 * Symmetric or asymmetric 3D Y-bifurcation with known daughter-daughter angle and radii.
 */
export function yBifurcationPhantom({
  dims = [64, 64, 64],
  spacing = [0.5, 0.5, 0.5],
  daughterAngleDeg = 90,
  parentRadiusMm = 2.0,
  daughter1RadiusMm = 1.5,
  daughter2RadiusMm = 1.5,
  armLengthMm = 10.0,
} = {}) {
  const mask = new Uint8Array(dims[0] * dims[1] * dims[2]);
  const center = [dims[0] * spacing[0] * 0.5, dims[1] * spacing[1] * 0.5, dims[2] * spacing[2] * 0.5];
  const parentEnd = [center[0], center[1] - armLengthMm, center[2]];
  const halfRad = ((daughterAngleDeg * 0.5) * Math.PI) / 180;
  const d1End = [
    center[0] - armLengthMm * Math.sin(halfRad),
    center[1] + armLengthMm * Math.cos(halfRad),
    center[2],
  ];
  const d2End = [
    center[0] + armLengthMm * Math.sin(halfRad),
    center[1] + armLengthMm * Math.cos(halfRad),
    center[2],
  ];

  paintCapsule(mask, dims, spacing, parentEnd, center, parentRadiusMm);
  paintCapsule(mask, dims, spacing, center, d1End, daughter1RadiusMm);
  paintCapsule(mask, dims, spacing, center, d2End, daughter2RadiusMm);

  const affine = makeOrthoAffine(spacing);
  return {
    mask,
    dims,
    spatial: inspectAffine(affine, 2),
    groundTruth: {
      daughterAngleDeg,
      parentDiameterMm: 2 * parentRadiusMm,
      daughter1DiameterMm: 2 * daughter1RadiusMm,
      daughter2DiameterMm: 2 * daughter2RadiusMm,
      segmentCount: 3,
      junctionCount: 1,
      bifurcationCount: 1,
      endpointCount: 3,
      cycleRankBetti1: 0,
    },
  };
}

/**
 * Closed torus phantom testing Circle-of-Willis loop preservation (Betti-1 = 1).
 */
export function torusLoopPhantom({
  dims = [64, 64, 32],
  spacing = [0.5, 0.5, 0.5],
  majorRadiusMm = 8.0,
  minorRadiusMm = 1.5,
} = {}) {
  const mask = new Uint8Array(dims[0] * dims[1] * dims[2]);
  const [nx, ny, nz] = dims;
  const [sx, sy, sz] = spacing;
  const slice = nx * ny;
  const cx = nx * sx * 0.5;
  const cy = ny * sy * 0.5;
  const cz = nz * sz * 0.5;

  for (let z = 0; z < nz; z += 1) {
    const dz = z * sz - cz;
    for (let y = 0; y < ny; y += 1) {
      const dy = y * sy - cy;
      const row = z * slice + y * nx;
      for (let x = 0; x < nx; x += 1) {
        const dx = x * sx - cx;
        const radial = Math.hypot(dx, dy) - majorRadiusMm;
        if (Math.hypot(radial, dz) <= minorRadiusMm) {
          mask[row + x] = 1;
        }
      }
    }
  }
  const affine = makeOrthoAffine(spacing);
  return {
    mask,
    dims,
    spatial: inspectAffine(affine, 2),
    groundTruth: {
      perimeterMm: 2 * Math.PI * majorRadiusMm,
      diameterMm: 2 * minorRadiusMm,
      cycleRankBetti1: 1,
      segmentCount: 1,
      junctionCount: 0,
      endpointCount: 0,
    },
  };
}

/**
 * 3D helical tube with exact analytical arc length, chord, DM tortuosity, and curvature.
 */
export function helixPhantom({
  dims = [64, 64, 72],
  spacing = [0.5, 0.5, 0.5],
  helixRadiusMm = 4.5,
  pitchMm = 10.0,
  turns = 1.5,
  tubeRadiusMm = 1.5,
} = {}) {
  const mask = new Uint8Array(dims[0] * dims[1] * dims[2]);
  const [nx, ny, nz] = dims;
  const [sx, sy, sz] = spacing;
  const cx = nx * sx * 0.5;
  const cy = ny * sy * 0.5;
  const z0 = (nz * sz - pitchMm * turns) * 0.5;
  const c = pitchMm / (2 * Math.PI);
  const tMax = 2 * Math.PI * turns;
  const steps = 160;
  const pts = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = (tMax * i) / steps;
    pts.push([cx + helixRadiusMm * Math.cos(t), cy + helixRadiusMm * Math.sin(t), z0 + c * t]);
  }
  for (let i = 1; i < pts.length; i += 1) {
    paintCapsule(mask, dims, spacing, pts[i - 1], pts[i], tubeRadiusMm);
  }
  const trueLengthMm = tMax * Math.hypot(helixRadiusMm, c);
  const pStart = pts[0];
  const pEnd = pts[pts.length - 1];
  const trueChordMm = Math.hypot(pEnd[0] - pStart[0], pEnd[1] - pStart[1], pEnd[2] - pStart[2]);
  const affine = makeOrthoAffine(spacing);
  return {
    mask,
    dims,
    spatial: inspectAffine(affine, 2),
    groundTruth: {
      lengthMm: trueLengthMm,
      chordMm: trueChordMm,
      dmTortuosity: trueLengthMm / trueChordMm,
      diameterMm: 2 * tubeRadiusMm,
      curvaturePerMm: helixRadiusMm / (helixRadiusMm * helixRadiusMm + c * c),
    },
  };
}

/**
 * Generates a spherical brain/ROI mask on the same grid as a phantom.
 */
export function sphereRoiMask(dims, spacing, radiusMm) {
  const mask = new Uint8Array(dims[0] * dims[1] * dims[2]);
  const [nx, ny, nz] = dims;
  const [sx, sy, sz] = spacing;
  const slice = nx * ny;
  const cx = nx * sx * 0.5;
  const cy = ny * sy * 0.5;
  const cz = nz * sz * 0.5;
  let count = 0;
  for (let z = 0; z < nz; z += 1) {
    const dz = z * sz - cz;
    for (let y = 0; y < ny; y += 1) {
      const dy = y * sy - cy;
      const row = z * slice + y * nx;
      for (let x = 0; x < nx; x += 1) {
        const dx = x * sx - cx;
        if (dx * dx + dy * dy + dz * dz <= radiusMm * radiusMm) {
          mask[row + x] = 1;
          count += 1;
        }
      }
    }
  }
  return { mask, voxelCount: count };
}
