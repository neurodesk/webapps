export function parseNiftiHeader(headerBuffer) {
  const view = headerBuffer instanceof DataView ? headerBuffer : new DataView(toArrayBuffer(headerBuffer));
  const dims = [];
  const pixDims = [];
  for (let i = 0; i < 8; i++) dims.push(view.getInt16(40 + i * 2, true));
  for (let i = 0; i < 8; i++) pixDims.push(view.getFloat32(76 + i * 4, true));
  return {
    dims,
    nx: dims[1],
    ny: dims[2],
    nz: dims[3],
    pixDims,
    voxelSize: [pixDims[1] || 1, pixDims[2] || 1, pixDims[3] || 1],
    datatype: view.getInt16(70, true),
    bitpix: view.getInt16(72, true),
    voxOffset: view.getFloat32(108, true),
    sclSlope: view.getFloat32(112, true) || 1,
    sclInter: view.getFloat32(116, true) || 0,
    affine: extractAffine(view)
  };
}

export function extractAffine(view) {
  const dataView = view instanceof DataView ? view : new DataView(toArrayBuffer(view));
  const sformCode = dataView.getInt16(254, true);
  const qformCode = dataView.getInt16(252, true);
  if (sformCode > 0) return extractSformAffine(dataView);
  if (qformCode > 0) return extractQformAffine(dataView);
  const pixDims = [];
  for (let i = 0; i < 4; i++) pixDims.push(dataView.getFloat32(76 + i * 4, true));
  return [
    new Float64Array([pixDims[1] || 1, 0, 0, 0]),
    new Float64Array([0, pixDims[2] || 1, 0, 0]),
    new Float64Array([0, 0, pixDims[3] || 1, 0]),
    new Float64Array([0, 0, 0, 1])
  ];
}

export function isGzipped(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(toArrayBuffer(data));
  return bytes[0] === 0x1f && bytes[1] === 0x8b;
}

export function isValidNifti1(data) {
  const buffer = toArrayBuffer(data);
  if (buffer.byteLength < 347) return false;
  const view = new DataView(buffer);
  return view.getUint8(344) === 0x6e
    && (view.getUint8(345) === 0x2b || view.getUint8(345) === 0x69)
    && view.getUint8(346) === 0x31;
}

export async function decodeNiftiBuffer(bufferLike) {
  const buffer = toArrayBuffer(bufferLike);
  if (!isGzipped(buffer)) return buffer;
  if (typeof DecompressionStream === 'function') {
    const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Response(stream).arrayBuffer();
  }
  try {
    const { gunzipSync } = await import('node:zlib');
    return toArrayBuffer(gunzipSync(new Uint8Array(buffer)));
  } catch (error) {
    throw new Error(`Compressed NIfTI decoding requires DecompressionStream or node:zlib: ${error.message}`);
  }
}

export async function readNifti(bufferLike, OutputCtor = Float32Array) {
  return readNiftiImageData(await decodeNiftiBuffer(bufferLike), OutputCtor);
}

export function readNiftiImageData(bufferLike, OutputCtor = Float32Array) {
  const buffer = toArrayBuffer(bufferLike);
  const view = new DataView(buffer);
  const header = parseNiftiHeader(view);
  const output = readScaledVoxels(view, header, header.nx * header.ny * header.nz, OutputCtor);
  return { data: output, header, dims: [header.nx, header.ny, header.nz] };
}

/** Every frame of a 4D (or higher) NIfTI, frame-major: voxel v of frame t is data[t * nx * ny * nz + v]. */
export function readNiftiFrames(bufferLike, OutputCtor = Float32Array) {
  const buffer = toArrayBuffer(bufferLike);
  const view = new DataView(buffer);
  const header = parseNiftiHeader(view);
  let frames = 1;
  for (let d = 4; d <= header.dims[0]; d++) frames *= Math.max(1, header.dims[d]);
  const output = readScaledVoxels(view, header, header.nx * header.ny * header.nz * frames, OutputCtor);
  return { data: output, header, dims: [header.nx, header.ny, header.nz], frames };
}

function readScaledVoxels(view, header, total, OutputCtor) {
  const dataStart = Math.ceil(header.voxOffset);
  const output = new OutputCtor(total);
  for (let i = 0; i < total; i++) {
    output[i] = readVoxel(view, dataStart, i, header.datatype) * header.sclSlope + header.sclInter;
  }
  return output;
}

export function parseNiftiVolume(bufferLike, options = {}) {
  let buffer = toArrayBuffer(bufferLike);
  if (isGzipped(buffer)) {
    if (typeof options.decompress !== 'function') throw new Error('Compressed NIfTI requires a decompress function');
    buffer = toArrayBuffer(options.decompress(buffer));
  }
  const header = parseNiftiHeader(buffer);
  const dimCount = header.dims[0];
  const timepoints = header.dims[4] || 1;
  if (dimCount > 4 || (dimCount === 4 && timepoints !== 1)) {
    throw new Error(`Unsupported NIfTI shape ${header.dims.slice(1, dimCount + 1).join('x')}; only 3D or singleton 4D volumes are supported.`);
  }
  const { data } = readNiftiImageData(buffer, options.OutputCtor || Float32Array);
  return {
    imageData: data,
    dims: [header.nx, header.ny, header.nz],
    voxelSize: header.voxelSize.map(value => Math.abs(value) || 1),
    headerBytes: extractNiftiHeader(buffer),
    affine: header.affine,
    header,
  };
}

export function extractNiftiHeader(bufferLike) {
  const buffer = toArrayBuffer(bufferLike);
  const view = new DataView(buffer);
  const headerSize = Math.ceil(view.getFloat32(108, true) || 352);
  return buffer.slice(0, headerSize);
}

export function createUint8Nifti(data, sourceHeader, dims = null) {
  return createTypedNifti(data, sourceHeader, { datatype: 2, bitpix: 8, bytesPerVoxel: 1, dims });
}

export function createFloat32Nifti(data, sourceHeader, dims = null) {
  return createTypedNifti(data, sourceHeader, { datatype: 16, bitpix: 32, bytesPerVoxel: 4, dims });
}

export function createFloat64Nifti(data, sourceHeader, dims = null) {
  return createTypedNifti(data, sourceHeader, { datatype: 64, bitpix: 64, bytesPerVoxel: 8, dims });
}

export function createMaskNifti(maskData, sourceHeader, dims = null) {
  const uint8 = maskData instanceof Uint8Array ? maskData : Uint8Array.from(maskData, value => value ? 1 : 0);
  return createUint8Nifti(uint8, sourceHeader, dims);
}

export function createNiftiFromData(data, sourceHeader, options = {}) {
  const format = NIFTI_FORMAT_BY_ARRAY.get(data?.constructor);
  if (!format) throw new Error(`Unsupported volume datatype: ${data?.constructor?.name || typeof data}`);
  const output = createTypedNifti(data, sourceHeader, {
    ...format,
    dims: options.dims || null,
    preserveScaling: options.preserveScaling === true,
  });
  const view = new DataView(output);
  if (options.spacing) {
    view.setFloat32(80, options.spacing[0], true);
    view.setFloat32(84, options.spacing[1], true);
    view.setFloat32(88, options.spacing[2], true);
  }
  let min = options.calMin;
  let max = options.calMax;
  if (options.range === 'auto') {
    min = Infinity;
    max = -Infinity;
    for (const value of data) {
      if (!Number.isFinite(value)) continue;
      if (value < min) min = value;
      if (value > max) max = value;
    }
  } else if (!Number.isFinite(max)) {
    max = -Infinity;
    for (const value of data) if (Number.isFinite(value) && value > max) max = value;
  }
  const safeMax = Number.isFinite(max) ? max : 1;
  view.setFloat32(124, options.clampCalMax === false ? safeMax : Math.max(1, safeMax), true);
  view.setFloat32(128, Number.isFinite(min) ? min : 0, true);
  return output;
}

export function createNiftiHeaderFromVolume(volume) {
  const headerSize = 352;
  const buffer = new ArrayBuffer(headerSize);
  const view = new DataView(buffer);
  const hdr = volume?.hdr || {};
  const dims = normalizeNiftiDims(hdr.dims || volume?.dims || [1, 1, 1]);
  const pixDims = normalizePixDims(hdr.pixDims || hdr.pixdim || volume?.pixDims || volume?.pixdim);

  view.setInt32(0, 348, true);
  for (let i = 0; i < 8; i++) view.setInt16(40 + i * 2, dims[i] || 0, true);
  view.setInt16(70, 16, true);
  view.setInt16(72, 32, true);
  for (let i = 0; i < 8; i++) view.setFloat32(76 + i * 4, pixDims[i] || 1, true);
  view.setFloat32(108, headerSize, true);
  view.setFloat32(112, hdr.scl_slope ?? hdr.sclSlope ?? 1, true);
  view.setFloat32(116, hdr.scl_inter ?? hdr.sclInter ?? 0, true);
  view.setUint8(123, 10);
  view.setInt16(252, hdr.qform_code || 1, true);
  view.setInt16(254, hdr.sform_code || 1, true);
  if (hdr.affine) {
    for (let i = 0; i < 4; i++) {
      view.setFloat32(280 + i * 4, hdr.affine[0]?.[i] || 0, true);
      view.setFloat32(296 + i * 4, hdr.affine[1]?.[i] || 0, true);
      view.setFloat32(312 + i * 4, hdr.affine[2]?.[i] || 0, true);
    }
  }
  view.setUint8(344, 0x6e);
  view.setUint8(345, 0x2b);
  view.setUint8(346, 0x31);
  view.setUint8(347, 0x00);
  return buffer;
}

export function createNiftiFromVolume(volume) {
  const header = createNiftiHeaderFromVolume(volume);
  const data = volume?.img || volume?.image || new Float32Array(0);
  return createNiftiFromData(data, header, { preserveScaling: true });
}

const NIFTI_FORMAT_BY_ARRAY = new Map([
  [Int8Array, { datatype: 256, bitpix: 8, bytesPerVoxel: 1 }],
  [Uint8Array, { datatype: 2, bitpix: 8, bytesPerVoxel: 1 }],
  [Int16Array, { datatype: 4, bitpix: 16, bytesPerVoxel: 2 }],
  [Uint16Array, { datatype: 512, bitpix: 16, bytesPerVoxel: 2 }],
  [Int32Array, { datatype: 8, bitpix: 32, bytesPerVoxel: 4 }],
  [Uint32Array, { datatype: 768, bitpix: 32, bytesPerVoxel: 4 }],
  [Float32Array, { datatype: 16, bitpix: 32, bytesPerVoxel: 4 }],
  [Float64Array, { datatype: 64, bitpix: 64, bytesPerVoxel: 8 }],
]);

function createTypedNifti(data, sourceHeader, options) {
  const header = toArrayBuffer(sourceHeader);
  const srcView = new DataView(header);
  const headerSize = Math.ceil(srcView.getFloat32(108, true) || 352);
  const buffer = new ArrayBuffer(headerSize + data.length * options.bytesPerVoxel);
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  bytes.set(new Uint8Array(header).slice(0, headerSize));

  view.setInt16(70, options.datatype, true);
  view.setInt16(72, options.bitpix, true);
  view.setInt16(40, 3, true);
  view.setInt16(48, 1, true);
  view.setFloat32(108, headerSize, true);
  if (!options.preserveScaling) {
    view.setFloat32(112, 1, true);
    view.setFloat32(116, 0, true);
  }
  if (options.dims) {
    view.setInt16(42, options.dims[0], true);
    view.setInt16(44, options.dims[1], true);
    view.setInt16(46, options.dims[2], true);
  }

  writeTypedData(view, headerSize, data, options.datatype);
  return buffer;
}

function normalizeNiftiDims(dims) {
  const result = [3, 1, 1, 1, 1, 1, 1, 1];
  if (!Array.isArray(dims) && !(dims instanceof Int16Array) && !(dims instanceof Uint16Array)) return result;
  if (dims.length >= 4 && dims[0] <= 7) {
    for (let i = 0; i < Math.min(8, dims.length); i++) result[i] = dims[i] || result[i];
    result[0] = Math.max(3, result[0]);
    return result;
  }
  for (let i = 0; i < Math.min(3, dims.length); i++) result[i + 1] = dims[i] || 1;
  return result;
}

function normalizePixDims(pixDims) {
  const result = [1, 1, 1, 1, 1, 1, 1, 1];
  if (!Array.isArray(pixDims) && !(pixDims instanceof Float32Array) && !(pixDims instanceof Float64Array)) return result;
  if (pixDims.length >= 4) {
    for (let i = 0; i < Math.min(8, pixDims.length); i++) result[i] = pixDims[i] || result[i];
    return result;
  }
  for (let i = 0; i < Math.min(3, pixDims.length); i++) result[i + 1] = pixDims[i] || 1;
  return result;
}

function writeFloat32Data(view, offset, data) {
  for (let i = 0; i < data.length; i++) view.setFloat32(offset + i * 4, data[i], true);
}

function writeFloat64Data(view, offset, data) {
  for (let i = 0; i < data.length; i++) view.setFloat64(offset + i * 8, data[i], true);
}

function writeTypedData(view, offset, data, datatype) {
  switch (datatype) {
    case 2: new Uint8Array(view.buffer, offset).set(data); break;
    case 4: for (let i = 0; i < data.length; i++) view.setInt16(offset + i * 2, data[i], true); break;
    case 8: for (let i = 0; i < data.length; i++) view.setInt32(offset + i * 4, data[i], true); break;
    case 16: writeFloat32Data(view, offset, data); break;
    case 64: writeFloat64Data(view, offset, data); break;
    case 256: new Int8Array(view.buffer, offset).set(data); break;
    case 512: for (let i = 0; i < data.length; i++) view.setUint16(offset + i * 2, data[i], true); break;
    case 768: for (let i = 0; i < data.length; i++) view.setUint32(offset + i * 4, data[i], true); break;
    default: throw new Error(`Unsupported output datatype: ${datatype}`);
  }
}

function readVoxel(view, dataStart, index, datatype) {
  switch (datatype) {
    case 2: return view.getUint8(dataStart + index);
    case 4: return view.getInt16(dataStart + index * 2, true);
    case 8: return view.getInt32(dataStart + index * 4, true);
    case 16: return view.getFloat32(dataStart + index * 4, true);
    case 64: return view.getFloat64(dataStart + index * 8, true);
    case 256: return view.getInt8(dataStart + index);
    case 512: return view.getUint16(dataStart + index * 2, true);
    case 768: return view.getUint32(dataStart + index * 4, true);
    default: throw new Error(`Unsupported NIfTI datatype: ${datatype}`);
  }
}

function extractSformAffine(view) {
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
  for (let i = 0; i < 4; i++) pixDims.push(view.getFloat32(76 + i * 4, true));
  const qb = view.getFloat32(256, true);
  const qc = view.getFloat32(260, true);
  const qd = view.getFloat32(264, true);
  const qx = view.getFloat32(268, true);
  const qy = view.getFloat32(272, true);
  const qz = view.getFloat32(276, true);
  const sqr = qb * qb + qc * qc + qd * qd;
  const qa = sqr > 1 ? 0 : Math.sqrt(1 - sqr);
  const qfac = pixDims[0] < 0 ? -1 : 1;
  const rotation = [
    [qa * qa + qb * qb - qc * qc - qd * qd, 2 * (qb * qc - qa * qd), 2 * (qb * qd + qa * qc)],
    [2 * (qb * qc + qa * qd), qa * qa + qc * qc - qb * qb - qd * qd, 2 * (qc * qd - qa * qb)],
    [2 * (qb * qd - qa * qc), 2 * (qc * qd + qa * qb), qa * qa + qd * qd - qb * qb - qc * qc]
  ];
  return [
    new Float64Array([rotation[0][0] * pixDims[1], rotation[0][1] * pixDims[2], rotation[0][2] * pixDims[3] * qfac, qx]),
    new Float64Array([rotation[1][0] * pixDims[1], rotation[1][1] * pixDims[2], rotation[1][2] * pixDims[3] * qfac, qy]),
    new Float64Array([rotation[2][0] * pixDims[1], rotation[2][1] * pixDims[2], rotation[2][2] * pixDims[3] * qfac, qz]),
    new Float64Array([0, 0, 0, 1])
  ];
}

function toArrayBuffer(value) {
  if (value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value)) return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
  throw new Error('Expected ArrayBuffer or typed array');
}
