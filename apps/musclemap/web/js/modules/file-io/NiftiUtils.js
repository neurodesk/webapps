/**
 * NIfTI Utilities Module
 *
 * Pure functions for parsing and creating NIfTI files.
 * Extended with affine matrix extraction for MuscleMap preprocessing.
 */

/**
 * Parse NIfTI header to extract dimensions and spatial metadata.
 * @param {ArrayBuffer} headerBuffer - 352-byte NIfTI-1 header
 * @returns {Object} Header info
 */
export function parseNiftiHeader(headerBuffer) {
  const view = new DataView(headerBuffer);

  const dims = [];
  for (let i = 0; i < 8; i++) {
    dims.push(view.getInt16(40 + i * 2, true));
  }

  const pixDims = [];
  for (let i = 0; i < 8; i++) {
    pixDims.push(view.getFloat32(76 + i * 4, true));
  }

  return {
    dims: dims,
    nx: dims[1],
    ny: dims[2],
    nz: dims[3],
    pixDims: pixDims,
    voxelSize: [pixDims[1] || 1, pixDims[2] || 1, pixDims[3] || 1],
    datatype: view.getInt16(70, true),
    bitpix: view.getInt16(72, true),
    voxOffset: view.getFloat32(108, true),
    sclSlope: view.getFloat32(112, true) || 1,
    sclInter: view.getFloat32(116, true) || 0,
  };
}

/**
 * Extract the 4x4 affine matrix from a NIfTI header.
 * Prefers sform if available, falls back to qform.
 * @param {DataView} view - DataView of the NIfTI header
 * @returns {Float64Array[]} 4x4 affine as array of 4 rows
 */
export function extractAffine(view) {
  const sformCode = view.getInt16(254, true);
  const qformCode = view.getInt16(252, true);

  if (sformCode > 0) {
    return extractSformAffine(view);
  } else if (qformCode > 0) {
    return extractQformAffine(view);
  }

  // Default: identity with pixdims
  const pixDims = [];
  for (let i = 0; i < 4; i++) {
    pixDims.push(view.getFloat32(76 + i * 4, true));
  }
  return [
    new Float64Array([pixDims[1] || 1, 0, 0, 0]),
    new Float64Array([0, pixDims[2] || 1, 0, 0]),
    new Float64Array([0, 0, pixDims[3] || 1, 0]),
    new Float64Array([0, 0, 0, 1])
  ];
}

function extractSformAffine(view) {
  // srow_x at offset 280, srow_y at 296, srow_z at 312 (each 4 float32s)
  const affine = [
    new Float64Array(4),
    new Float64Array(4),
    new Float64Array(4),
    new Float64Array([0, 0, 0, 1])
  ];
  for (let i = 0; i < 4; i++) {
    affine[0][i] = view.getFloat32(280 + i * 4, true);
    affine[1][i] = view.getFloat32(296 + i * 4, true);
    affine[2][i] = view.getFloat32(312 + i * 4, true);
  }
  return affine;
}

function extractQformAffine(view) {
  const pixDims = [];
  for (let i = 0; i < 4; i++) {
    pixDims.push(view.getFloat32(76 + i * 4, true));
  }

  // Quaternion parameters
  const qb = view.getFloat32(256, true);
  const qc = view.getFloat32(260, true);
  const qd = view.getFloat32(264, true);
  const qx = view.getFloat32(268, true);
  const qy = view.getFloat32(272, true);
  const qz = view.getFloat32(276, true);

  // Compute qa
  const sqr = qb * qb + qc * qc + qd * qd;
  const qa = sqr > 1.0 ? 0.0 : Math.sqrt(1.0 - sqr);

  // Rotation matrix from quaternion
  const R = [
    [qa*qa + qb*qb - qc*qc - qd*qd, 2*(qb*qc - qa*qd), 2*(qb*qd + qa*qc)],
    [2*(qb*qc + qa*qd), qa*qa + qc*qc - qb*qb - qd*qd, 2*(qc*qd - qa*qb)],
    [2*(qb*qd - qa*qc), 2*(qc*qd + qa*qb), qa*qa + qd*qd - qb*qb - qc*qc]
  ];

  // qfac for z-flip
  const qfac = pixDims[0] < 0 ? -1 : 1;

  const affine = [
    new Float64Array([R[0][0] * pixDims[1], R[0][1] * pixDims[2], R[0][2] * pixDims[3] * qfac, qx]),
    new Float64Array([R[1][0] * pixDims[1], R[1][1] * pixDims[2], R[1][2] * pixDims[3] * qfac, qy]),
    new Float64Array([R[2][0] * pixDims[1], R[2][1] * pixDims[2], R[2][2] * pixDims[3] * qfac, qz]),
    new Float64Array([0, 0, 0, 1])
  ];
  return affine;
}

/**
 * Check if data is gzip compressed
 */
export function isGzipped(data) {
  return data[0] === 0x1f && data[1] === 0x8b;
}

/**
 * Read NIfTI image data from uncompressed buffer
 */
export function readNiftiImageData(data) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  const dims = [];
  for (let i = 0; i < 8; i++) {
    dims.push(view.getInt16(40 + i * 2, true));
  }
  const nTotal = dims[1] * dims[2] * dims[3];

  const datatype = view.getInt16(70, true);
  const voxOffset = view.getFloat32(108, true);
  const sclSlope = view.getFloat32(112, true) || 1;
  const sclInter = view.getFloat32(116, true) || 0;
  const dataStart = Math.ceil(voxOffset);
  const result = new Float64Array(nTotal);

  switch (datatype) {
    case 2: // UINT8
      for (let i = 0; i < nTotal; i++) result[i] = data[dataStart + i] * sclSlope + sclInter;
      break;
    case 4: // INT16
      for (let i = 0; i < nTotal; i++) result[i] = view.getInt16(dataStart + i * 2, true) * sclSlope + sclInter;
      break;
    case 8: // INT32
      for (let i = 0; i < nTotal; i++) result[i] = view.getInt32(dataStart + i * 4, true) * sclSlope + sclInter;
      break;
    case 16: // FLOAT32
      for (let i = 0; i < nTotal; i++) result[i] = view.getFloat32(dataStart + i * 4, true) * sclSlope + sclInter;
      break;
    case 64: // FLOAT64
      for (let i = 0; i < nTotal; i++) result[i] = view.getFloat64(dataStart + i * 8, true) * sclSlope + sclInter;
      break;
    case 512: // UINT16
      for (let i = 0; i < nTotal; i++) result[i] = view.getUint16(dataStart + i * 2, true) * sclSlope + sclInter;
      break;
    default:
      throw new Error(`Unsupported NIfTI datatype: ${datatype}`);
  }

  return result;
}

function getGlobalNiftiDecoder() {
  const root = typeof window !== 'undefined' ? window : globalThis;
  return root.nifti || null;
}

function readNiftiHeaderView(buffer) {
  const view = new DataView(buffer);
  const littleEndian = view.getInt32(0, true) === 348;

  if (!littleEndian && view.getInt32(0, false) !== 348) {
    throw new Error('File is not a NIfTI-1 volume');
  }

  const dims = [];
  for (let i = 0; i < 8; i++) {
    dims.push(view.getInt16(40 + i * 2, littleEndian));
  }

  const datatype = view.getInt16(70, littleEndian);
  const bitpix = view.getInt16(72, littleEndian);
  const voxOffset = Math.max(352, Math.ceil(view.getFloat32(108, littleEndian) || 352));
  const sclSlope = view.getFloat32(112, littleEndian) || 1;
  const sclInter = view.getFloat32(116, littleEndian) || 0;

  if (dims[0] < 3 || dims[1] <= 0 || dims[2] <= 0 || dims[3] <= 0) {
    throw new Error('NIfTI volume has invalid dimensions');
  }

  return {
    view,
    littleEndian,
    dims,
    nx: dims[1],
    ny: dims[2],
    nz: dims[3],
    datatype,
    bitpix,
    voxOffset,
    sclSlope,
    sclInter
  };
}

function getDatatypeBytes(datatype) {
  switch (datatype) {
    case 2:
    case 256:
      return 1;
    case 4:
    case 512:
      return 2;
    case 8:
    case 16:
    case 768:
      return 4;
    case 64:
    case 1024:
    case 1280:
      return 8;
    default:
      throw new Error(`Unsupported NIfTI datatype: ${datatype}`);
  }
}

function readRawVoxel(view, byteOffset, datatype, littleEndian) {
  switch (datatype) {
    case 2:
      return view.getUint8(byteOffset);
    case 4:
      return view.getInt16(byteOffset, littleEndian);
    case 8:
      return view.getInt32(byteOffset, littleEndian);
    case 16:
      return view.getFloat32(byteOffset, littleEndian);
    case 64:
      return view.getFloat64(byteOffset, littleEndian);
    case 256:
      return view.getInt8(byteOffset);
    case 512:
      return view.getUint16(byteOffset, littleEndian);
    case 768:
      return view.getUint32(byteOffset, littleEndian);
    case 1024:
      return Number(view.getBigInt64(byteOffset, littleEndian));
    case 1280:
      return Number(view.getBigUint64(byteOffset, littleEndian));
    default:
      throw new Error(`Unsupported NIfTI datatype: ${datatype}`);
  }
}

function readScaledVoxel(header, byteOffset) {
  return readRawVoxel(header.view, byteOffset, header.datatype, header.littleEndian) *
    header.sclSlope + header.sclInter;
}

function percentile(sortedValues, p) {
  if (sortedValues.length === 0) return NaN;

  const index = (sortedValues.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sortedValues[lower];

  const weight = index - lower;
  return sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight;
}

function computePreviewDims(header, maxBytes, maxDimension) {
  const voxelCount = header.nx * header.ny * header.nz;
  const maxVoxels = Math.max(1, maxBytes);
  const voxelFactor = Math.ceil(Math.cbrt(voxelCount / maxVoxels));
  const dimensionFactor = Math.ceil(Math.max(header.nx, header.ny, header.nz) / maxDimension);
  const factor = Math.max(1, voxelFactor, dimensionFactor);

  return {
    nx: Math.max(1, Math.ceil(header.nx / factor)),
    ny: Math.max(1, Math.ceil(header.ny / factor)),
    nz: Math.max(1, Math.ceil(header.nz / factor)),
    factor
  };
}

function updatePreviewHeader(outputView, header, outputDims) {
  outputView.setInt16(40, 3, header.littleEndian);
  outputView.setInt16(42, outputDims.nx, header.littleEndian);
  outputView.setInt16(44, outputDims.ny, header.littleEndian);
  outputView.setInt16(46, outputDims.nz, header.littleEndian);
  outputView.setInt16(48, 1, header.littleEndian);
  outputView.setInt16(50, 1, header.littleEndian);
  outputView.setInt16(52, 1, header.littleEndian);
  outputView.setInt16(54, 1, header.littleEndian);

  outputView.setInt16(70, 2, header.littleEndian); // UINT8
  outputView.setInt16(72, 8, header.littleEndian);
  outputView.setFloat32(112, 1, header.littleEndian);
  outputView.setFloat32(116, 0, header.littleEndian);
  outputView.setFloat32(124, 255, header.littleEndian);
  outputView.setFloat32(128, 0, header.littleEndian);

  const scales = [
    header.nx / outputDims.nx,
    header.ny / outputDims.ny,
    header.nz / outputDims.nz
  ];

  for (let i = 0; i < 3; i++) {
    const pixdimOffset = 80 + i * 4;
    const pixdim = outputView.getFloat32(pixdimOffset, header.littleEndian);
    outputView.setFloat32(pixdimOffset, pixdim * scales[i], header.littleEndian);
  }

  const sformCode = outputView.getInt16(254, header.littleEndian);
  if (sformCode > 0) {
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 3; col++) {
        const offset = 280 + row * 16 + col * 4;
        outputView.setFloat32(
          offset,
          outputView.getFloat32(offset, header.littleEndian) * scales[col],
          header.littleEndian
        );
      }
    }
  }

  return scales;
}

/**
 * Create a display-only uint8 NIfTI preview from a larger source NIfTI.
 * Voxel intensities are robust-scaled into 0..255, and very large volumes are
 * spatially downsampled so WebGL viewers can use a much smaller texture.
 */
export async function createUint8PreviewNiftiFile(file, options = {}) {
  const {
    lowerPercentile = 0.005,
    upperPercentile = 0.995,
    maxSamples = 262144,
    maxPreviewBytes = 64 * 1024 ** 2,
    maxPreviewDimension = 512,
    suffix = '8bit-preview'
  } = options;

  let buffer = await file.arrayBuffer();
  const nifti = getGlobalNiftiDecoder();
  if (nifti?.isCompressed?.(buffer)) {
    buffer = nifti.decompress(buffer);
  }

  const header = readNiftiHeaderView(buffer);
  const bytesPerVoxel = getDatatypeBytes(header.datatype);
  const voxelCount = header.nx * header.ny * header.nz;
  const dataBytes = voxelCount * bytesPerVoxel;
  const outputDims = computePreviewDims(header, maxPreviewBytes, maxPreviewDimension);
  const outputVoxelCount = outputDims.nx * outputDims.ny * outputDims.nz;

  if (header.voxOffset + dataBytes > buffer.byteLength) {
    throw new Error('NIfTI image data is truncated');
  }

  const sampleStride = Math.max(1, Math.floor(voxelCount / maxSamples));
  const sampleCapacity = Math.ceil(voxelCount / sampleStride);
  const samples = new Float32Array(sampleCapacity);
  let sampleCount = 0;

  for (let i = 0; i < voxelCount; i += sampleStride) {
    const byteOffset = header.voxOffset + i * bytesPerVoxel;
    const value = readScaledVoxel(header, byteOffset);
    if (Number.isFinite(value)) {
      samples[sampleCount] = value;
      sampleCount += 1;
    }
  }

  if (sampleCount === 0) {
    throw new Error('No finite voxels found for display preview');
  }

  const sortedSamples = samples.subarray(0, sampleCount);
  sortedSamples.sort();

  let sourceMin = percentile(sortedSamples, lowerPercentile);
  let sourceMax = percentile(sortedSamples, upperPercentile);
  if (!Number.isFinite(sourceMin) || !Number.isFinite(sourceMax) || sourceMax <= sourceMin) {
    sourceMin = sortedSamples[0];
    sourceMax = sortedSamples[sortedSamples.length - 1];
  }
  if (sourceMax <= sourceMin) sourceMax = sourceMin + 1;

  const outputBuffer = new ArrayBuffer(header.voxOffset + outputVoxelCount);
  const inputBytes = new Uint8Array(buffer);
  const outputBytes = new Uint8Array(outputBuffer);
  const outputView = new DataView(outputBuffer);
  outputBytes.set(inputBytes.subarray(0, header.voxOffset));
  const scales = updatePreviewHeader(outputView, header, outputDims);
  const outputData = new Uint8Array(outputBuffer, header.voxOffset, outputVoxelCount);
  const scale = 255 / (sourceMax - sourceMin);

  for (let z = 0; z < outputDims.nz; z++) {
    const srcZ = Math.min(header.nz - 1, Math.floor((z + 0.5) * scales[2]));
    for (let y = 0; y < outputDims.ny; y++) {
      const srcY = Math.min(header.ny - 1, Math.floor((y + 0.5) * scales[1]));
      for (let x = 0; x < outputDims.nx; x++) {
        const srcX = Math.min(header.nx - 1, Math.floor((x + 0.5) * scales[0]));
        const inputIndex = srcX + srcY * header.nx + srcZ * header.nx * header.ny;
        const byteOffset = header.voxOffset + inputIndex * bytesPerVoxel;
        const value = readScaledVoxel(header, byteOffset);
        const scaled = Number.isFinite(value) ? Math.round((value - sourceMin) * scale) : 0;
        outputData[x + y * outputDims.nx + z * outputDims.nx * outputDims.ny] =
          Math.max(0, Math.min(255, scaled));
      }
    }
  }

  const baseName = (file.name || 'volume').replace(/\.(nii|nii\.gz)$/i, '');
  const previewFile = new File(
    [outputBuffer],
    `${baseName}.${suffix}.nii`,
    { type: 'application/octet-stream' }
  );

  return {
    file: previewFile,
    sourceMin,
    sourceMax,
    dims: [outputDims.nx, outputDims.ny, outputDims.nz],
    originalDims: [header.nx, header.ny, header.nz],
    downsampleFactors: scales,
    voxelCount,
    previewVoxelCount: outputVoxelCount,
    originalBytes: file.size || buffer.byteLength,
    previewBytes: previewFile.size
  };
}

/**
 * Create a NIfTI buffer with uint8 label data.
 */
export function createUint8Nifti(uint8Data, sourceHeader) {
  const srcView = new DataView(sourceHeader);
  const voxOffset = srcView.getFloat32(108, true);
  const headerSize = Math.ceil(voxOffset);

  const buffer = new ArrayBuffer(headerSize + uint8Data.length);
  const destBytes = new Uint8Array(buffer);
  const destView = new DataView(buffer);

  destBytes.set(new Uint8Array(sourceHeader).slice(0, headerSize));

  // Datatype = UINT8 (2), bitpix = 8
  destView.setInt16(70, 2, true);
  destView.setInt16(72, 8, true);
  destView.setInt16(40, 3, true); // dim[0] = 3
  destView.setInt16(48, 1, true); // dim[4] = 1
  destView.setFloat32(112, 1, true); // scl_slope = 1
  destView.setFloat32(116, 0, true); // scl_inter = 0
  destView.setFloat32(124, 255, true); // cal_max
  destView.setFloat32(128, 0, true); // cal_min

  new Uint8Array(buffer, headerSize).set(uint8Data);
  return buffer;
}

/**
 * Create a NIfTI buffer with float32 data.
 */
export function createFloat32Nifti(float32Data, sourceHeader) {
  const srcView = new DataView(sourceHeader);
  const voxOffset = srcView.getFloat32(108, true);
  const headerSize = Math.ceil(voxOffset);

  const dataSize = float32Data.length * 4;
  const buffer = new ArrayBuffer(headerSize + dataSize);
  const destBytes = new Uint8Array(buffer);
  const destView = new DataView(buffer);

  destBytes.set(new Uint8Array(sourceHeader).slice(0, headerSize));

  destView.setInt16(70, 16, true); // FLOAT32
  destView.setInt16(72, 32, true);
  destView.setInt16(40, 3, true);
  destView.setInt16(48, 1, true);
  destView.setFloat32(112, 1, true);
  destView.setFloat32(116, 0, true);

  new Float32Array(buffer, headerSize).set(float32Data);
  return buffer;
}

/**
 * Create a minimal NIfTI header from NiiVue volume.
 */
export function createNiftiHeaderFromVolume(vol) {
  const headerSize = 352;
  const buffer = new ArrayBuffer(headerSize);
  const view = new DataView(buffer);
  const hdr = vol.hdr;

  view.setInt32(0, 348, true);
  const dims = hdr.dims || [3, vol.dims[1], vol.dims[2], vol.dims[3], 1, 1, 1, 1];
  for (let i = 0; i < 8; i++) view.setInt16(40 + i * 2, dims[i] || 0, true);
  view.setInt16(70, 16, true);
  view.setInt16(72, 32, true);
  const pixdim = hdr.pixDims || [1, 1, 1, 1, 1, 1, 1, 1];
  for (let i = 0; i < 8; i++) view.setFloat32(76 + i * 4, pixdim[i] || 1, true);
  view.setFloat32(108, headerSize, true);
  view.setFloat32(112, hdr.scl_slope || 1, true);
  view.setFloat32(116, hdr.scl_inter || 0, true);
  view.setUint8(123, 10);
  view.setInt16(252, hdr.qform_code || 1, true);
  view.setInt16(254, hdr.sform_code || 1, true);
  if (hdr.affine) {
    for (let i = 0; i < 4; i++) {
      view.setFloat32(280 + i * 4, hdr.affine[0][i] || 0, true);
      view.setFloat32(296 + i * 4, hdr.affine[1][i] || 0, true);
      view.setFloat32(312 + i * 4, hdr.affine[2][i] || 0, true);
    }
  }
  view.setUint8(344, 0x6E);
  view.setUint8(345, 0x2B);
  view.setUint8(346, 0x31);
  view.setUint8(347, 0x00);

  return buffer;
}

/**
 * Extract the header portion of a NIfTI file.
 */
export function extractNiftiHeader(niftiData) {
  const view = new DataView(niftiData.buffer, niftiData.byteOffset, niftiData.byteLength);
  const voxOffset = view.getFloat32(108, true);
  const headerSize = Math.ceil(voxOffset);
  const header = new ArrayBuffer(headerSize);
  new Uint8Array(header).set(niftiData.slice(0, headerSize));
  return header;
}
