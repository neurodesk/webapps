const SPATIAL_META = new WeakMap();
const META_PROP = Symbol.for('vesselboost.spatialMetadata');

export const VOLUME_SPACES = {
  SOURCE_NATIVE: 'source-native'
};

export function analysisVolumeSpace(gridId) {
  return gridId ? `analysis:${gridId}` : 'analysis:unknown';
}

function cloneDims(dims) {
  return Array.isArray(dims) ? dims.slice(0, 3).map(Number) : undefined;
}

function cloneAffine(affine) {
  if (!affine) return undefined;
  if (Array.isArray(affine) && affine.length === 4 && Array.isArray(affine[0])) {
    return affine.map(row => row.slice(0, 4).map(Number));
  }
  if (Array.isArray(affine) && affine.length >= 12) {
    return [
      [Number(affine[0]), Number(affine[1]), Number(affine[2]), Number(affine[3])],
      [Number(affine[4]), Number(affine[5]), Number(affine[6]), Number(affine[7])],
      [Number(affine[8]), Number(affine[9]), Number(affine[10]), Number(affine[11])],
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
  const current = getSpatialMetadata(file);
  const spatial = {
    ...current,
    ...metadata,
    dims: cloneDims(metadata.dims) || current?.dims,
    affine: cloneAffine(metadata.affine) || current?.affine
  };
  SPATIAL_META.set(file, spatial);
  try {
    Object.defineProperty(file, META_PROP, {
      value: spatial,
      configurable: true
    });
  } catch (e) {
    // WeakMap remains authoritative for non-extensible browser File objects.
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

export function readNiftiSpatialMetadata(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 348) return null;
  const bytes = new Uint8Array(buffer);
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) return null;

  const view = new DataView(buffer);
  const littleEndian = view.getInt32(0, true) === 348;
  const bigEndian = view.getInt32(0, false) === 348;
  if (!littleEndian && !bigEndian) return null;
  const le = littleEndian;
  const dims = [
    view.getInt16(42, le),
    view.getInt16(44, le),
    view.getInt16(46, le)
  ];
  if (dims.some(value => !Number.isFinite(value) || value <= 0)) return null;

  const affine = [
    [view.getFloat32(280, le), view.getFloat32(284, le), view.getFloat32(288, le), view.getFloat32(292, le)],
    [view.getFloat32(296, le), view.getFloat32(300, le), view.getFloat32(304, le), view.getFloat32(308, le)],
    [view.getFloat32(312, le), view.getFloat32(316, le), view.getFloat32(320, le), view.getFloat32(324, le)],
    [0, 0, 0, 1]
  ];
  const spacing = [
    view.getFloat32(80, le),
    view.getFloat32(84, le),
    view.getFloat32(88, le)
  ];
  return { dims, affine, spacing };
}

export function spatialGridId(metadata) {
  const dims = metadata?.dims?.join('x') || 'unknown';
  const affine = metadata?.affine
    ? metadata.affine.slice(0, 3).flat().map(value => Number(value).toFixed(4)).join(',')
    : 'no-affine';
  let hash = 0;
  const key = `${dims}|${affine}`;
  for (let i = 0; i < key.length; i++) {
    hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}
