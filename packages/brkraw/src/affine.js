// Exact port of BrkRaw v0.5.7 coordinate-space & affine resolver
// (src/brkraw/resolver/affine.py and src/brkraw/apps/loader/helper.py, GPL-3.0-only).

export const SUBJECT_TYPES = Object.freeze(['Biped', 'Quadruped']);
export const SUBJECT_POSES = Object.freeze([
  'Head_Supine',
  'Head_Prone',
  'Head_Left',
  'Head_Right',
  'Foot_Supine',
  'Foot_Prone',
  'Foot_Left',
  'Foot_Right',
]);
export const AFFINE_SPACES = Object.freeze(['subject_ras', 'scanner', 'raw']);

function matMul3(a, b) {
  const out = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r][c] = a[r][0] * b[0][c] + a[r][1] * b[1][c] + a[r][2] * b[2][c];
    }
  }
  return out;
}

function matVec3(m, v) {
  return [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
  ];
}

function det3(m) {
  return (
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
    - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
    + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
  );
}

export function fromMatvec(mat, vec) {
  return [
    [mat[0][0], mat[0][1], mat[0][2], vec[0]],
    [mat[1][0], mat[1][1], mat[1][2], vec[1]],
    [mat[2][0], mat[2][1], mat[2][2], vec[2]],
    [0, 0, 0, 1],
  ];
}

export function toMatvec(affine) {
  const mat = [
    [affine[0][0], affine[0][1], affine[0][2]],
    [affine[1][0], affine[1][1], affine[1][2]],
    [affine[2][0], affine[2][1], affine[2][2]],
  ];
  const vec = [affine[0][3], affine[1][3], affine[2][3]];
  return { mat, vec };
}

export function rotateAffine(affine, { radX = 0, radY = 0, radZ = 0, pivot = null } = {}) {
  const cx = Math.cos(radX);
  const sx = Math.sin(radX);
  const cy = Math.cos(radY);
  const sy = Math.sin(radY);
  const cz = Math.cos(radZ);
  const sz = Math.sin(radZ);

  const Rx = [
    [1, 0, 0],
    [0, cx, -sx],
    [0, sx, cx],
  ];
  const Ry = [
    [cy, 0, sy],
    [0, 1, 0],
    [-sy, 0, cy],
  ];
  const Rz = [
    [cz, -sz, 0],
    [sz, cz, 0],
    [0, 0, 1],
  ];
  const R = matMul3(Rz, matMul3(Ry, Rx));
  const { mat, vec } = toMatvec(affine);
  const mNew = matMul3(R, mat);
  let tNew = matVec3(R, vec);
  if (pivot) {
    const rp = matVec3(R, pivot);
    tNew = [tNew[0] + pivot[0] - rp[0], tNew[1] + pivot[1] - rp[1], tNew[2] + pivot[2] - rp[2]];
  }
  return fromMatvec(mNew, tNew);
}

export function flipAffine(affine, { flipX = false, flipY = false, flipZ = false, pivot = null } = {}) {
  const F = [
    [flipX ? -1 : 1, 0, 0],
    [0, flipY ? -1 : 1, 0],
    [0, 0, flipZ ? -1 : 1],
  ];
  const { mat, vec } = toMatvec(affine);
  const mNew = matMul3(F, mat);
  let tNew = matVec3(F, vec);
  if (pivot) {
    const fp = matVec3(F, pivot);
    tNew = [tNew[0] + pivot[0] - fp[0], tNew[1] + pivot[1] - fp[1], tNew[2] + pivot[2] - fp[2]];
  }
  return fromMatvec(mNew, tNew);
}

export function flipVoxelAxisAffine(affine, axis, shape) {
  const n = Math.trunc(shape[axis]);
  if (n <= 1) return affine.map((r) => [...r]);
  const { mat, vec } = toMatvec(affine);
  const col = [mat[0][axis], mat[1][axis], mat[2][axis]];
  mat[0][axis] = -col[0];
  mat[1][axis] = -col[1];
  mat[2][axis] = -col[2];
  const tNew = [
    vec[0] + col[0] * (n - 1),
    vec[1] + col[1] * (n - 1),
    vec[2] + col[2] * (n - 1),
  ];
  return fromMatvec(mat, tNew);
}

function splitPose(subjectPose) {
  const str = String(subjectPose || 'Head_Supine');
  const idx = str.indexOf('_');
  if (idx === -1) return [str, 'Supine'];
  return [str.slice(0, idx), str.slice(idx + 1)];
}

/** Exact port of `brkraw.resolver.affine.unwrap_to_scanner_xyz`. */
export function unwrapToScannerXyz(affine, subjectType, subjectPose) {
  let out = affine.map((r) => [...r]);
  const [headOrFoot, gravity] = splitPose(subjectPose);
  const type = subjectType || 'Biped'; // PV5.1 backward compatibility

  if (headOrFoot === 'Foot') {
    out = rotateAffine(out, { radY: Math.PI });
  }
  if (type === 'Biped') {
    out = flipAffine(out, { flipY: true });
    if (gravity === 'Prone') out = rotateAffine(out, { radZ: Math.PI });
    else if (gravity === 'Left') out = rotateAffine(out, { radZ: -Math.PI / 2 });
    else if (gravity === 'Right') out = rotateAffine(out, { radZ: Math.PI / 2 });
  } else if (type === 'Quadruped') {
    out = flipAffine(out, { flipX: true });
    if (gravity === 'Supine') out = rotateAffine(out, { radZ: Math.PI });
    else if (gravity === 'Left') out = rotateAffine(out, { radZ: Math.PI / 2 });
    else if (gravity === 'Right') out = rotateAffine(out, { radZ: -Math.PI / 2 });
  }
  return out;
}

/** Exact port of `brkraw.resolver.affine.wrap_to_subject_ras`. */
export function wrapToSubjectRas(affine, subjectType, subjectPose) {
  let out = affine.map((r) => [...r]);
  const [headOrFoot, gravity] = splitPose(subjectPose);
  if (headOrFoot === 'Foot') {
    out = rotateAffine(out, { radY: Math.PI });
  }
  const type = subjectType || 'Biped';
  if (type === 'Biped') {
    out = flipAffine(out, { flipZ: true });
    out = rotateAffine(out, { radY: Math.PI });
    if (gravity === 'Prone') out = rotateAffine(out, { radZ: Math.PI });
    else if (gravity === 'Left') out = rotateAffine(out, { radZ: Math.PI / 2 });
    else if (gravity === 'Right') out = rotateAffine(out, { radZ: -Math.PI / 2 });
  } else if (type === 'Quadruped') {
    out = flipAffine(out, { flipZ: true });
    out = rotateAffine(out, { radX: Math.PI / 2 });
    if (gravity === 'Supine') out = rotateAffine(out, { radZ: Math.PI });
    else if (gravity === 'Left') out = rotateAffine(out, { radZ: -Math.PI / 2 });
    else if (gravity === 'Right') out = rotateAffine(out, { radZ: Math.PI / 2 });
  }
  return out;
}

function toFlatNumbers(val) {
  if (val === null || val === undefined) return [];
  if (typeof val === 'number') return [val];
  if (Array.isArray(val)) {
    const out = [];
    const walk = (x) => {
      if (Array.isArray(x)) x.forEach(walk);
      else out.push(Number(x));
    };
    walk(val);
    return out;
  }
  return [Number(val)];
}

function toRows(val, width, name) {
  const flat = toFlatNumbers(val);
  if (flat.length === 0 || flat.length % width !== 0) {
    throw new Error(`${name} has ${flat.length} values, expected a multiple of ${width}.`);
  }
  const rows = [];
  for (let i = 0; i < flat.length; i += width) {
    rows.push(flat.slice(i, i + width));
  }
  return rows;
}

function asArray(val, fallback) {
  if (val === null || val === undefined) return fallback;
  return Array.isArray(val) ? val : [val];
}

export function resolveSlicePack(method) {
  if (!method || !method.hasKeyMatching('spack')) return null;
  const numSlicePacks = Number(method.get('PVM_NSPacks') || 1);
  const numSlices = asArray(method.get('PVM_SPackArrNSlices'), [1]).map((n) => Number(n));
  const sliceThickness = asArray(method.get('PVM_SPackArrSliceDistance'), [0]).map((n) => Number(n));
  const sliceGap = asArray(method.get('PVM_SPackArrSliceGap'), [0]).map((n) => Number(n));
  return {
    numSlicePacks,
    numSlices,
    sliceThickness,
    sliceGap,
    unit: 'mm',
  };
}

function resolveMatvecAndShape(visuPars, spackIdx, numSlices, sliceThickness) {
  const dim = Number(visuPars.get('VisuCoreDim'));
  const rotateRows = toRows(visuPars.get('VisuCoreOrientation'), 9, 'VisuCoreOrientation');
  const originRows = toRows(visuPars.get('VisuCorePosition'), 3, 'VisuCorePosition');
  const extent = toFlatNumbers(visuPars.get('VisuCoreExtent'));
  const shape = toFlatNumbers(visuPars.get('VisuCoreSize')).map((n) => Math.trunc(n));

  let row;
  let col;
  let slc;
  let vec;

  if (dim === 2) {
    const numSlicePack = numSlices.length;
    if (spackIdx < 0 || spackIdx >= numSlicePack) {
      throw new RangeError(`spackIdx out of range: ${spackIdx} (packs: ${numSlicePack})`);
    }
    const totalSlices = numSlices.reduce((a, b) => a + b, 0);
    const start = numSlices.slice(0, spackIdx).reduce((a, b) => a + b, 0);
    const count = numSlices[spackIdx];

    const selectSliceEntries = (rows, name) => {
      let trimmed = rows;
      if (trimmed.length > totalSlices) {
        trimmed = trimmed.slice(0, totalSlices);
      }
      if (trimmed.length === totalSlices) {
        return trimmed.slice(start, start + count);
      }
      if (trimmed.length === numSlicePack) {
        if (count !== 1) {
          throw new Error(`${name} provides one entry per slice pack, but pack ${spackIdx} has ${count} slices.`);
        }
        return [trimmed[spackIdx]];
      }
      throw new Error(`${name} has ${trimmed.length} entries, expected ${totalSlices} or ${numSlicePack}.`);
    };

    const packRot = selectSliceEntries(rotateRows, 'VisuCoreOrientation');
    const packOrig = selectSliceEntries(originRows, 'VisuCorePosition');
    row = packRot[0].slice(0, 3);
    col = packRot[0].slice(3, 6);
    slc = packRot[0].slice(6, 9);

    const norm = Math.hypot(slc[0], slc[1], slc[2]) || 1;
    const n = [slc[0] / norm, slc[1] / norm, slc[2] / norm];
    if (count > 1) {
      let bestIdx = 0;
      let bestProj = Infinity;
      for (let i = 0; i < packOrig.length; i++) {
        const p = packOrig[i][0] * n[0] + packOrig[i][1] * n[1] + packOrig[i][2] * n[2];
        if (p < bestProj) {
          bestProj = p;
          bestIdx = i;
        }
      }
      vec = [...packOrig[bestIdx]];
    } else {
      vec = [...packOrig[0]];
    }
    shape.push(count);
    extent.push(count * sliceThickness[spackIdx]);
  } else {
    const spackSlices = visuPars.get('VisuCoreSlicePacksSlices');
    const spackCount = Array.isArray(spackSlices) && spackSlices.length > 0 ? spackSlices.length : null;
    const selectPackRow = (rows, name) => {
      if (rows.length === 1 || spackCount === null || spackCount === 1) return rows[0];
      if (spackIdx < 0 || spackIdx >= rows.length) {
        throw new RangeError(`spackIdx out of range for ${name}: ${spackIdx}`);
      }
      return rows[spackIdx];
    };
    const r = selectPackRow(rotateRows, 'VisuCoreOrientation');
    const o = selectPackRow(originRows, 'VisuCorePosition');
    row = r.slice(0, 3);
    col = r.slice(3, 6);
    slc = r.slice(6, 9);
    vec = [...o];
  }

  const resols = [extent[0] / shape[0], extent[1] / shape[1], extent[2] / shape[2]];
  const mat = [
    [row[0] * resols[0], col[0] * resols[1], slc[0] * resols[2]],
    [row[1] * resols[0], col[1] * resols[1], slc[1] * resols[2]],
    [row[2] * resols[0], col[2] * resols[1], slc[2] * resols[2]],
  ];
  return { mat, vec, shape };
}

function roundHalfToEven(x) {
  const neg = x < 0;
  const ax = Math.abs(x);
  const f = Math.floor(ax);
  const diff = ax - f;
  let r;
  if (diff < 0.5) r = f;
  else if (diff > 0.5) r = f + 1;
  else r = f % 2 === 0 ? f : f + 1;
  return neg ? (r === 0 ? 0 : -r) : r;
}

function roundAffine(affine, decimals) {
  if (decimals === null || decimals === undefined) return affine;
  const factor = 10 ** decimals;
  return affine.map((r) => r.map((v) => {
    const rounded = roundHalfToEven(v * factor) / factor;
    return rounded === 0 ? 0 : rounded;
  }));
}

/**
 * Resolve per-slice-pack 4x4 NIfTI affines for a Bruker scan/reco, matching `brkraw` v0.5.7.
 */
export function resolveAffines({
  acqp,
  method,
  visuPars,
  space = 'subject_ras',
  overrideSubjectType = null,
  overrideSubjectPose = null,
  decimals = 6,
}) {
  if (!AFFINE_SPACES.includes(space)) {
    throw new Error(`Unsupported coordinate space: ${space}`);
  }
  const hasOverride = Boolean(overrideSubjectType || overrideSubjectPose);
  if (hasOverride && space !== 'subject_ras') {
    throw new Error("Subject type/pose overrides are only supported when space='subject_ras'.");
  }

  const sliceInfo = resolveSlicePack(method);
  if (!sliceInfo) return null;

  const sliceOrientRaw = method.get('PVM_SPackArrSliceOrient');
  const sliceOrientArr = Array.isArray(sliceOrientRaw) ? sliceOrientRaw : [sliceOrientRaw];
  const phaseDir = Number(acqp.get('ACQ_scaling_phase') ?? 1) || 1;

  const { numSlicePacks, sliceGap } = sliceInfo;
  let { numSlices } = sliceInfo;
  const sliceThickness = sliceInfo.sliceThickness.map((t, i) => t + (sliceGap[i] ?? 0));

  const subjType = visuPars.get('VisuSubjectType') || null;
  const subjPose = visuPars.get('VisuSubjectPosition') || 'Head_Supine';

  const rawAffines = [];
  let lastShape = null;
  for (let spackIdx = 0; spackIdx < numSlicePacks; spackIdx++) {
    const spackOrient = numSlicePacks === 1 ? sliceOrientArr[0] : sliceOrientArr[spackIdx];
    const { mat, vec, shape } = resolveMatvecAndShape(visuPars, spackIdx, numSlices, sliceThickness);
    lastShape = shape;
    let affine = fromMatvec(mat, vec);
    if (phaseDir < 0) {
      affine = flipVoxelAxisAffine(affine, 1, shape);
    }
    if (spackOrient === 'coronal') {
      affine = flipVoxelAxisAffine(affine, 2, shape);
    }
    rawAffines.push(roundAffine(affine, decimals));
  }

  if (lastShape && numSlicePacks === 1 && numSlices[0] === 1 && lastShape[2] !== numSlices[0]) {
    numSlices = [lastShape[2]];
  }

  let affines;
  if (space === 'raw') {
    affines = rawAffines;
  } else {
    const scannerAffines = rawAffines.map((a) => unwrapToScannerXyz(a, subjType, subjPose));
    if (space === 'scanner') {
      affines = scannerAffines.map((a) => roundAffine(a, decimals));
    } else {
      const useType = overrideSubjectType || subjType;
      const usePose = overrideSubjectPose || subjPose;
      affines = scannerAffines.map((a) => roundAffine(wrapToSubjectRas(a, useType, usePose), decimals));
    }
  }

  return {
    numSlicePacks,
    affines,
    numSlices,
    sliceOrientations: sliceOrientArr.slice(0, numSlicePacks),
    subjectType: subjType,
    subjectPosition: subjPose,
    effectiveSubjectType: overrideSubjectType || subjType || 'Biped',
    effectiveSubjectPosition: overrideSubjectPose || subjPose,
    space,
    detSigns: affines.map((a) => (det3(toMatvec(a).mat) < 0 ? -1 : 1)),
  };
}
