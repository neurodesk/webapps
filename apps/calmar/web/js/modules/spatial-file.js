const SPATIAL_META = new WeakMap();
const META_PROP = Symbol.for('lnm.spatialMetadata');

export const VOLUME_SPACES = {
  NATIVE_T1: 'native-t1',
  NATIVE_DWI: 'native-dwi',
  MNI160: 'mni160'
};

export function atlasVolumeSpace(atlasAssetId) {
  return atlasAssetId ? `atlas:${atlasAssetId}` : 'atlas:unknown';
}

export function atlasOptionSpace(atlasOption, kind = 'overlap') {
  const assetId = kind === 'affected'
    ? (atlasOption?.affectedAtlasAssetId || atlasOption?.overlapAtlasAssetId)
    : atlasOption?.overlapAtlasAssetId;
  return atlasVolumeSpace(assetId);
}

function cloneDims(dims) {
  return Array.isArray(dims) ? dims.slice(0, 3).map(Number) : undefined;
}

function cloneAffine(affine) {
  if (!affine) return undefined;
  if (Array.isArray(affine) && affine.length === 4 && Array.isArray(affine[0])) {
    return affine.map(row => row.slice());
  }
  if (Array.isArray(affine) && affine.length >= 12) {
    return [
      [affine[0], affine[1], affine[2], affine[3]],
      [affine[4], affine[5], affine[6], affine[7]],
      [affine[8], affine[9], affine[10], affine[11]],
      [0, 0, 0, 1]
    ];
  }
  return undefined;
}

function dimsEqual(a, b) {
  if (!a || !b) return true;
  return a.length === b.length && a.every((value, index) => Number(value) === Number(b[index]));
}

function affineEqual(a, b, tolerance = 1e-3) {
  if (!a || !b) return true;
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      if (Math.abs(Number(a[r]?.[c]) - Number(b[r]?.[c])) > tolerance) return false;
    }
  }
  return true;
}

export function tagSpatialFile(file, metadata = {}) {
  if (!file || typeof file !== 'object') return file;
  const spatial = {
    ...getSpatialMetadata(file),
    ...metadata,
    dims: cloneDims(metadata.dims) || getSpatialMetadata(file)?.dims,
    affine: cloneAffine(metadata.affine) || getSpatialMetadata(file)?.affine
  };
  SPATIAL_META.set(file, spatial);
  try {
    Object.defineProperty(file, META_PROP, {
      value: spatial,
      configurable: true
    });
  } catch (e) {
    // Some browser File implementations may be non-extensible; WeakMap above
    // remains authoritative in that case.
  }
  return file;
}

export function getSpatialMetadata(file) {
  if (!file || typeof file !== 'object') return null;
  return SPATIAL_META.get(file) || file[META_PROP] || null;
}

export function spatialLabel(fileOrMeta) {
  const meta = fileOrMeta?.space ? fileOrMeta : getSpatialMetadata(fileOrMeta);
  return meta?.space || 'untracked';
}

export function assertSpace(file, expectedSpace, context = 'Volume', { requireMetadata = false } = {}) {
  const meta = getSpatialMetadata(file);
  if (!meta?.space) {
    if (requireMetadata) {
      throw new Error(`${context}: missing spatial metadata; expected ${expectedSpace}.`);
    }
    return true;
  }
  if (meta.space !== expectedSpace) {
    throw new Error(`${context}: expected ${expectedSpace}, got ${meta.space}.`);
  }
  return true;
}

export function assertSameSpace(baseFile, overlayFile, context = 'Volume stack', {
  requireMetadata = false,
  checkDims = true,
  checkAffine = true
} = {}) {
  const base = getSpatialMetadata(baseFile);
  const overlay = getSpatialMetadata(overlayFile);
  if (!base?.space || !overlay?.space) {
    if (requireMetadata) {
      throw new Error(
        `${context}: missing spatial metadata ` +
        `(base=${base?.space || 'untracked'}, overlay=${overlay?.space || 'untracked'}).`
      );
    }
    return true;
  }
  if (base.space !== overlay.space) {
    throw new Error(`${context}: base is in ${base.space}, overlay is in ${overlay.space}.`);
  }
  if (checkDims && !dimsEqual(base.dims, overlay.dims)) {
    throw new Error(
      `${context}: matching space ${base.space} but dimensions differ ` +
      `(${base.dims?.join('x') || 'unknown'} vs ${overlay.dims?.join('x') || 'unknown'}).`
    );
  }
  if (checkAffine && !affineEqual(base.affine, overlay.affine)) {
    throw new Error(`${context}: matching space ${base.space} but affines differ.`);
  }
  return true;
}

export function assertVolumeStackSpaces(entries, context = 'Volume stack', options = {}) {
  if (!Array.isArray(entries) || entries.length <= 1) return true;
  const base = entries[0]?.file;
  for (const entry of entries.slice(1)) {
    assertSameSpace(base, entry?.file, `${context}: ${entry?.stage || entry?.file?.name || 'overlay'}`, options);
  }
  return true;
}
