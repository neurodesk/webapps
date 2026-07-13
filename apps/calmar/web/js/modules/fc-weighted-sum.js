// Group-FC weighted sum — the algorithmic core of the lesion network map.
//
// Inputs (all on the same MNI grid):
//   - channelWeights: Float32Array(N), per-network or per-parcel lesion
//     weights. Order matches the loaded FC channels.
//   - tMaps: array of N Float32Arrays, each length X*Y*Z in NIfTI voxel
//     order (x + y*X + z*X*Y), one per network/parcel. Per-channel group
//     t-statistic against zero of the seed-to-voxel Fisher-z connectivity.
//     Decoded from the packed .bin via decodeFcPack.
//   - dims: [X, Y, Z] — the FC atlas grid.
//
// Output:
//   Float32Array length X*Y*Z, the per-voxel weighted-sum t-stat. Lesions
//   that lie wholly in one channel reproduce that channel's t-map; lesions
//   spanning multiple channels linearly combine. The result is *not*
//   thresholded here — Phase 5's threshold UI lives separately.

export function fcWeightedSum(channelWeights, tMaps, dims) {
  if (!Array.isArray(dims) || dims.length !== 3) {
    throw new Error('fcWeightedSum: dims must be [X, Y, Z]');
  }
  const expected = dims[0] * dims[1] * dims[2];
  if (!channelWeights || channelWeights.length === 0) {
    throw new Error('fcWeightedSum: weights must contain at least one channel');
  }
  if (!Array.isArray(tMaps) || tMaps.length !== channelWeights.length) {
    throw new Error(
      `fcWeightedSum: tMaps length ${tMaps?.length || 0} must match weights length ${channelWeights.length}`
    );
  }
  for (let k = 0; k < tMaps.length; k++) {
    if (tMaps[k].length !== expected) {
      throw new Error(
        `fcWeightedSum: tMap[${k}] length ${tMaps[k].length} != ${expected} (dim mismatch)`
      );
    }
  }

  const out = new Float32Array(expected);
  for (let k = 0; k < tMaps.length; k++) {
    const w = channelWeights[k];
    if (w === 0) continue;
    const t = tMaps[k];
    for (let v = 0; v < expected; v++) out[v] += w * t[v];
  }
  return out;
}

export function rowMajorToNiftiOrder(data, dims) {
  if (!Array.isArray(dims) || dims.length !== 3) {
    throw new Error('rowMajorToNiftiOrder: dims must be [X, Y, Z]');
  }
  const [X, Y, Z] = dims;
  const expected = X * Y * Z;
  if (data.length !== expected) {
    throw new Error(`rowMajorToNiftiOrder: data length ${data.length} != ${expected}`);
  }

  const out = new Float32Array(expected);
  for (let x = 0; x < X; x++) {
    const srcX = x * Y * Z;
    for (let y = 0; y < Y; y++) {
      const srcXY = srcX + y * Z;
      for (let z = 0; z < Z; z++) {
        out[x + y * X + z * X * Y] = data[srcXY + z];
      }
    }
  }
  return out;
}

function fcPackVoxelOrder(index) {
  const order = index.voxelOrder || index.storageOrder || 'row-major';
  if (order === 'row-major' || order === 'c-order') return 'row-major';
  if (order === 'nifti' || order === 'f-order' || order === 'fortran') return 'nifti';
  throw new Error(`decodeFcPack: unsupported voxelOrder '${order}'`);
}

function float16ToFloat32Bits(h) {
  const s = (h & 0x8000) << 16;
  const e = (h & 0x7c00) >> 10;
  const f = h & 0x03ff;
  if (e === 0) {
    if (f === 0) return s;
    let fraction = f;
    let exp = -1;
    while ((fraction & 0x0400) === 0) {
      fraction <<= 1;
      exp -= 1;
    }
    fraction &= 0x03ff;
    return s | ((exp + 127) << 23) | (fraction << 13);
  }
  if (e === 0x1f) {
    return s | 0x7f800000 | (f << 13);
  }
  return s | ((e + 112) << 23) | (f << 13);
}

export function float16ToFloat32Array(uint16Array) {
  const out = new Float32Array(uint16Array.length);
  const scratch = new ArrayBuffer(4);
  const u32 = new Uint32Array(scratch);
  const f32 = new Float32Array(scratch);
  for (let i = 0; i < uint16Array.length; i++) {
    u32[0] = float16ToFloat32Bits(uint16Array[i]);
    out[i] = f32[0];
  }
  return out;
}

function decodeChannel(raw, dtype) {
  if (dtype === 'float32') return raw;
  if (dtype === 'float16') return float16ToFloat32Array(new Uint16Array(
    raw.buffer,
    raw.byteOffset,
    raw.byteLength / 2
  ));
  throw new Error(`decodeFcPack: only float32/float16 supported, got ${dtype}`);
}

// Read the packed .bin contents into one Float32Array per channel. The
// arrayBuffer is the result of fetch(...).arrayBuffer(). The index JSON is the
// companion file emitted by the connectome builder script.
//
// Returns:
//   { tMaps: Float32Array[], byNetwork: { [name]: Float32Array }, voxelsPerMap }
//
// Current packs are written by NumPy's ndarray.tofile(), which emits C/row-major
// bytes. The rest of this app uses NIfTI order, so decode at the asset boundary
// before any thresholding or NIfTI serialization happens.
export function decodeFcPack(arrayBuffer, index) {
  if (!index || !Array.isArray(index.shape) || index.shape.length !== 4) {
    throw new Error('decodeFcPack: index.shape must be [N, X, Y, Z]');
  }
  const [N, X, Y, Z] = index.shape;
  if (N <= 0) throw new Error(`decodeFcPack: pack must have at least one channel, got ${N}`);
  const voxelsPerMap = X * Y * Z;
  if (voxelsPerMap !== index.voxelsPerMap) {
    throw new Error(
      `decodeFcPack: voxelsPerMap mismatch ${voxelsPerMap} vs ${index.voxelsPerMap}`
    );
  }
  const voxelOrder = fcPackVoxelOrder(index);
  const dtype = index.dtype || 'float32';
  const bytesPerValue = dtype === 'float16' ? 2 : 4;
  const dims = [X, Y, Z];
  const tMaps = [];
  for (let k = 0; k < N; k++) {
    const byteOffset = k * voxelsPerMap * bytesPerValue;
    const rawBytes = new Uint8Array(arrayBuffer, byteOffset, voxelsPerMap * bytesPerValue);
    const decoded = dtype === 'float32'
      ? new Float32Array(arrayBuffer, byteOffset, voxelsPerMap)
      : decodeChannel(rawBytes, dtype);
    tMaps.push(voxelOrder === 'row-major' ? rowMajorToNiftiOrder(decoded, dims) : decoded);
  }
  const byNetwork = {};
  if (index.networkLabels) {
    for (const [labelStr, name] of Object.entries(index.networkLabels)) {
      const k = Number(labelStr) - 1;
      if (k >= 0 && k < N) byNetwork[name] = tMaps[k];
    }
  }
  const byChannel = {};
  const channelLabels = index.channelLabels || index.parcelLabels || index.networkLabels || {};
  for (const [labelStr, name] of Object.entries(channelLabels)) {
    const k = Number(labelStr) - 1;
    if (k >= 0 && k < N) byChannel[name] = tMaps[k];
  }
  return { tMaps, byNetwork, byChannel, voxelsPerMap };
}

// Convert the output of `summarizeNetworkOverlap` (parcel-overlap.js)
// into a length-7 weight vector aligned to the FC pack's network order.
//
//   summary: { totalLesionVoxels, networks: [{network, voxelsInLesion, fractionOfLesion, ...}, ...] }
//   networkOrder: ['Visual', ..., 'Default'] (must match the FC pack's index)
//
// Networks present in the summary but not in networkOrder (typically
// 'Unassigned') are dropped — there's no FC channel for them, so they
// can't contribute to the weighted sum. Their voxelsInLesion silently
// reduces the total fraction; the caller may want to renormalise the
// returned weights to sum to 1, but we don't auto-do that — the
// fraction-of-lesion semantic is preserved by reading directly from
// summary.networks[].fractionOfLesion.
export function summaryToNetworkWeights(summary, networkOrder) {
  if (!summary || !Array.isArray(summary.networks)) {
    throw new Error('summaryToNetworkWeights: bad summary input');
  }
  if (!Array.isArray(networkOrder) || networkOrder.length === 0) {
    throw new Error('summaryToNetworkWeights: networkOrder must be a non-empty array');
  }
  const weights = new Float32Array(networkOrder.length);
  const byName = {};
  for (const row of summary.networks) byName[row.network] = row;
  for (let k = 0; k < networkOrder.length; k++) {
    const row = byName[networkOrder[k]];
    weights[k] = row ? Number(row.fractionOfLesion) || 0 : 0;
  }
  return weights;
}

export function parcelResultToChannelWeights(parcelResult, channelLabels) {
  if (!parcelResult || !Array.isArray(parcelResult.parcels)) {
    throw new Error('parcelResultToChannelWeights: bad parcelResult input');
  }
  const labels = Array.isArray(channelLabels)
    ? channelLabels.map(String)
    : Object.keys(channelLabels || {}).sort((a, b) => Number(a) - Number(b));
  if (labels.length === 0) {
    throw new Error('parcelResultToChannelWeights: channelLabels must not be empty');
  }
  const byLabel = new Map(parcelResult.parcels.map(parcel => [String(parcel.label), parcel]));
  const weights = new Float32Array(labels.length);
  for (let k = 0; k < labels.length; k++) {
    const parcel = byLabel.get(labels[k]);
    weights[k] = parcel ? Number(parcel.fractionOfLesion) || 0 : 0;
  }
  return { weights, labels };
}
