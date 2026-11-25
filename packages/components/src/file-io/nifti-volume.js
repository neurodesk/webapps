// Spec-compliant NIfTI-1 and NIfTI-2 reader/writer with exact NiBabel affine
// precedence (sform_code > 0 > qform_code > 0 > LAS-centered fallback), verbatim
// qform+sform preservation, post-Float32Array finiteness checking, and bounded
// gzip decompression support. Pure JavaScript (no DOM, no Node-only imports).

const SPATIAL_UNIT_MM = { 1: 1000, 2: 1, 3: 0.001 };

const SCALAR_TYPES = Object.freeze({
  2: { method: 'getUint8', bytes: 1, bigint: false },
  4: { method: 'getInt16', bytes: 2, bigint: false },
  8: { method: 'getInt32', bytes: 4, bigint: false },
  16: { method: 'getFloat32', bytes: 4, bigint: false },
  64: { method: 'getFloat64', bytes: 8, bigint: false },
  256: { method: 'getInt8', bytes: 1, bigint: false },
  512: { method: 'getUint16', bytes: 2, bigint: false },
  768: { method: 'getUint32', bytes: 4, bigint: false },
  1024: { method: 'getBigInt64', bytes: 8, bigint: true },
  1280: { method: 'getBigUint64', bytes: 8, bigint: true },
});

const WRITE_TYPES = new Map([
  [Uint8Array, { code: 2, bitpix: 8, bytes: 1, method: 'setUint8' }],
  [Int16Array, { code: 4, bitpix: 16, bytes: 2, method: 'setInt16' }],
  [Int32Array, { code: 8, bitpix: 32, bytes: 4, method: 'setInt32' }],
  [Float32Array, { code: 16, bitpix: 32, bytes: 4, method: 'setFloat32' }],
  [Float64Array, { code: 64, bitpix: 64, bytes: 8, method: 'setFloat64' }],
  [Int8Array, { code: 256, bitpix: 8, bytes: 1, method: 'setInt8' }],
  [Uint16Array, { code: 512, bitpix: 16, bytes: 2, method: 'setUint16' }],
  [Uint32Array, { code: 768, bitpix: 32, bytes: 4, method: 'setUint32' }],
]);

function toUint8(bufferLike) {
  if (bufferLike instanceof Uint8Array) return bufferLike;
  if (bufferLike instanceof ArrayBuffer) return new Uint8Array(bufferLike);
  if (ArrayBuffer.isView(bufferLike)) {
    return new Uint8Array(bufferLike.buffer, bufferLike.byteOffset, bufferLike.byteLength);
  }
  throw new Error('Expected an ArrayBuffer or typed array.');
}

function isGzipBytes(bytes) {
  return bytes.byteLength >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

function readMagic(bytes, offset) {
  return String.fromCharCode(
    bytes[offset],
    bytes[offset + 1],
    bytes[offset + 2],
    bytes[offset + 3],
  );
}

function safeBigIntToNumber(big, label) {
  const num = Number(big);
  if (!Number.isSafeInteger(num)) {
    throw new Error(`NIfTI-2 ${label} exceeds safe integer range: ${big.toString()}`);
  }
  return num;
}

export function affineDeterminant3(affine) {
  const [[a, b, c], [d, e, f], [g, h, i]] = affine;
  return a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
}

/**
 * Compute NiBabel-exact qform 4x4 affine from header fields.
 */
export function computeQformAffine({
  pixdim0,
  pixDims,
  quaternB,
  quaternC,
  quaternD,
  qoffsetX,
  qoffsetY,
  qoffsetZ,
}) {
  const qfac = pixdim0 < 0 ? -1 : 1;
  let b = quaternB;
  let c = quaternC;
  let d = quaternD;
  const a2 = 1 - (b * b + c * c + d * d);
  let a;
  if (a2 <= 1e-7) {
    a = 0;
    const norm = Math.hypot(b, c, d);
    if (norm > 0) {
      b /= norm;
      c /= norm;
      d /= norm;
    }
  } else {
    a = Math.sqrt(a2);
  }
  const r00 = a * a + b * b - c * c - d * d;
  const r01 = 2 * (b * c - a * d);
  const r02 = 2 * (b * d + a * c);
  const r10 = 2 * (b * c + a * d);
  const r11 = a * a + c * c - b * b - d * d;
  const r12 = 2 * (c * d - a * b);
  const r20 = 2 * (b * d - a * c);
  const r21 = 2 * (c * d + a * b);
  const r22 = a * a + d * d - b * b - c * c;

  const dx = pixDims[0];
  const dy = pixDims[1];
  const dz = pixDims[2] * qfac;
  const z = (v) => (v === 0 ? 0 : v);
  return [
    [z(r00 * dx), z(r01 * dy), z(r02 * dz), z(qoffsetX)],
    [z(r10 * dx), z(r11 * dy), z(r12 * dz), z(qoffsetY)],
    [z(r20 * dx), z(r21 * dy), z(r22 * dz), z(qoffsetZ)],
    [0, 0, 0, 1],
  ];
}

/**
 * Compute NiBabel's fallback LAS-centered base affine when both sform_code and
 * qform_code are 0: diag(-abs(pixdim[1]), abs(pixdim[2]), abs(pixdim[3]))
 * centered at (dim - 1) / 2.
 */
export function computeFallbackAffine(dims, pixDims) {
  const dx = Math.abs(pixDims[0]) || 1;
  const dy = Math.abs(pixDims[1]) || 1;
  const dz = Math.abs(pixDims[2]) || 1;
  const cx = (dims[0] - 1) / 2;
  const cy = (dims[1] - 1) / 2;
  const cz = (dims[2] - 1) / 2;
  return [
    [-dx, 0, 0, dx * cx],
    [0, dy, 0, -dy * cy],
    [0, 0, dz, -dz * cz],
    [0, 0, 0, 1],
  ];
}

/**
 * Parse a NIfTI-1 or NIfTI-2 header (uncompressed bytes) using NiBabel's exact
 * affine precedence: sform_code > 0 > qform_code > 0 > LAS-centered fallback.
 */
export function parseNiftiVolumeHeader(bufferLike) {
  const bytes = toUint8(bufferLike);
  if (bytes.byteLength < 348) {
    throw new Error('Choose a valid NIfTI-1 or NIfTI-2 image (.nii or .nii.gz).');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let version = 0;
  let littleEndian = true;
  if (view.getInt32(0, true) === 348) {
    version = 1;
    littleEndian = true;
  } else if (view.getInt32(0, false) === 348) {
    version = 1;
    littleEndian = false;
  } else if (bytes.byteLength >= 540 && view.getInt32(0, true) === 540) {
    version = 2;
    littleEndian = true;
  } else if (bytes.byteLength >= 540 && view.getInt32(0, false) === 540) {
    version = 2;
    littleEndian = false;
  } else {
    throw new Error('Choose a valid NIfTI-1 or NIfTI-2 image (.nii or .nii.gz).');
  }

  let dims;
  let pixDimsAll;
  let datatype;
  let bitpix;
  let voxOffset;
  let sclSlope;
  let sclInter;
  let xyztUnits;
  let qformCode;
  let sformCode;
  let quaternB;
  let quaternC;
  let quaternD;
  let qoffsetX;
  let qoffsetY;
  let qoffsetZ;
  let srowX;
  let srowY;
  let srowZ;

  if (version === 1) {
    const magic = readMagic(bytes, 344);
    if (magic === 'ni1\0') {
      throw new Error('Split .hdr/.img NIfTI pairs (ni1) are not supported; pass a single .nii or .nii.gz file.');
    }
    if (magic !== 'n+1\0') {
      throw new Error('Input is not a valid NIfTI-1 single-file image (expected n+1 magic).');
    }
    dims = Array.from({ length: 8 }, (_, i) => view.getInt16(40 + i * 2, littleEndian));
    datatype = view.getInt16(70, littleEndian);
    bitpix = view.getInt16(72, littleEndian);
    pixDimsAll = Array.from({ length: 8 }, (_, i) => view.getFloat32(76 + i * 4, littleEndian));
    voxOffset = view.getFloat32(108, littleEndian);
    sclSlope = view.getFloat32(112, littleEndian);
    sclInter = view.getFloat32(116, littleEndian);
    xyztUnits = view.getUint8(123);
    qformCode = view.getInt16(252, littleEndian);
    sformCode = view.getInt16(254, littleEndian);
    quaternB = view.getFloat32(256, littleEndian);
    quaternC = view.getFloat32(260, littleEndian);
    quaternD = view.getFloat32(264, littleEndian);
    qoffsetX = view.getFloat32(268, littleEndian);
    qoffsetY = view.getFloat32(272, littleEndian);
    qoffsetZ = view.getFloat32(276, littleEndian);
    srowX = Array.from({ length: 4 }, (_, c) => view.getFloat32(280 + c * 4, littleEndian));
    srowY = Array.from({ length: 4 }, (_, c) => view.getFloat32(296 + c * 4, littleEndian));
    srowZ = Array.from({ length: 4 }, (_, c) => view.getFloat32(312 + c * 4, littleEndian));
  } else {
    const magic = readMagic(bytes, 4);
    if (magic === 'ni2\0') {
      throw new Error('Split .hdr/.img NIfTI-2 pairs (ni2) are not supported; pass a single .nii or .nii.gz file.');
    }
    if (magic !== 'n+2\0') {
      throw new Error('Input is not a valid NIfTI-2 single-file image (expected n+2 magic).');
    }
    datatype = view.getInt16(12, littleEndian);
    bitpix = view.getInt16(14, littleEndian);
    dims = Array.from({ length: 8 }, (_, i) =>
      safeBigIntToNumber(view.getBigInt64(16 + i * 8, littleEndian), `dim[${i}]`),
    );
    pixDimsAll = Array.from({ length: 8 }, (_, i) => view.getFloat64(104 + i * 8, littleEndian));
    voxOffset = safeBigIntToNumber(view.getBigInt64(168, littleEndian), 'vox_offset');
    sclSlope = view.getFloat64(176, littleEndian);
    sclInter = view.getFloat64(184, littleEndian);
    qformCode = view.getInt32(344, littleEndian);
    sformCode = view.getInt32(348, littleEndian);
    quaternB = view.getFloat64(352, littleEndian);
    quaternC = view.getFloat64(360, littleEndian);
    quaternD = view.getFloat64(368, littleEndian);
    qoffsetX = view.getFloat64(376, littleEndian);
    qoffsetY = view.getFloat64(384, littleEndian);
    qoffsetZ = view.getFloat64(392, littleEndian);
    srowX = Array.from({ length: 4 }, (_, c) => view.getFloat64(400 + c * 8, littleEndian));
    srowY = Array.from({ length: 4 }, (_, c) => view.getFloat64(432 + c * 8, littleEndian));
    srowZ = Array.from({ length: 4 }, (_, c) => view.getFloat64(464 + c * 8, littleEndian));
    xyztUnits = view.getInt32(500, littleEndian);
  }

  const transforms = {
    qformCode,
    sformCode,
    pixdim0: pixDimsAll[0],
    pixDims: [pixDimsAll[1], pixDimsAll[2], pixDimsAll[3]],
    quaternB,
    quaternC,
    quaternD,
    qoffsetX,
    qoffsetY,
    qoffsetZ,
    srowX,
    srowY,
    srowZ,
    xyztUnits,
  };

  let rawAffine;
  let affineSource;
  if (sformCode > 0) {
    rawAffine = [
      [...srowX],
      [...srowY],
      [...srowZ],
      [0, 0, 0, 1],
    ];
    affineSource = 'sform';
  } else if (qformCode > 0) {
    rawAffine = computeQformAffine(transforms);
    affineSource = 'qform';
  } else {
    rawAffine = computeFallbackAffine(dims.slice(1, 4), transforms.pixDims);
    affineSource = 'fallback';
  }

  const unitScale = SPATIAL_UNIT_MM[xyztUnits & 7] ?? 1;
  const affine = rawAffine.map((row, r) => row.map((v) => (r < 3 ? v * unitScale : v)));

  return {
    version,
    littleEndian,
    dims,
    pixDims: pixDimsAll,
    datatype,
    bitpix,
    voxOffset,
    sclSlope,
    sclInter,
    xyztUnits,
    qformCode,
    sformCode,
    affine,
    affineSource,
    transforms,
  };
}

/**
 * Read a scalar 3D NIfTI-1 or NIfTI-2 volume into Float32Array with NiBabel
 * affine precedence, optional bounded gzip decompression, and post-Float32Array
 * finiteness checking.
 */
export function readNiftiVolume(
  bufferLike,
  {
    decompress = null,
    maxVoxels = 128 * 1024 * 1024,
    maxDecompressedBytes = 512 * 1024 * 1024,
  } = {},
) {
  let bytes = toUint8(bufferLike);
  if (isGzipBytes(bytes)) {
    if (typeof decompress !== 'function') {
      throw new Error('Compressed NIfTI input requires a decompress function.');
    }
    bytes = toUint8(decompress(bytes, { maxOutputLength: maxDecompressedBytes }));
  }

  const header = parseNiftiVolumeHeader(bytes);
  const ndim = header.dims[0];
  if (!Number.isInteger(ndim) || ndim < 3 || ndim > 7) {
    throw new Error(`Unsupported NIfTI dimensionality dim[0]=${ndim}; expected a 3D volume.`);
  }
  if (header.dims.slice(4, ndim + 1).some((d) => d > 1)) {
    throw new Error('This operation needs a single 3D image. Extract a volume from this 4D image first.');
  }
  const dims = [header.dims[1], header.dims[2], header.dims[3]];
  if (dims.some((d) => !Number.isInteger(d) || d < 2)) {
    throw new Error(`Unsupported image dimensions: ${dims.join('x')}.`);
  }
  const totalVoxels = dims[0] * dims[1] * dims[2];
  if (!Number.isSafeInteger(totalVoxels) || totalVoxels > maxVoxels) {
    throw new Error(`Image volume (${dims.join('x')}) exceeds supported voxel limit (${maxVoxels}).`);
  }

  const type = SCALAR_TYPES[header.datatype];
  if (!type) {
    throw new Error(`Unsupported NIfTI datatype ${header.datatype}. Use a scalar intensity image.`);
  }
  const minHeaderBytes = header.version === 2 ? 540 : 348;
  const dataOffset = Math.trunc(header.voxOffset);
  if (
    !Number.isFinite(header.voxOffset)
    || header.voxOffset !== dataOffset
    || dataOffset < minHeaderBytes
    || dataOffset + totalVoxels * type.bytes > bytes.byteLength
  ) {
    throw new Error('The NIfTI voxel data is truncated or has an invalid vox_offset.');
  }

  if (
    header.affine.flat().some((v) => !Number.isFinite(v))
    || Math.abs(affineDeterminant3(header.affine)) < 1e-12
  ) {
    throw new Error('Invalid or singular NIfTI affine.');
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const useScale = Number.isFinite(header.sclSlope) && header.sclSlope !== 0;
  const slope = useScale ? header.sclSlope : 1;
  const inter = useScale && Number.isFinite(header.sclInter) ? header.sclInter : 0;

  const data = new Float32Array(totalVoxels);
  for (let i = 0; i < totalVoxels; i += 1) {
    const raw = view[type.method](dataOffset + i * type.bytes, header.littleEndian);
    const val = (type.bigint ? Number(raw) : raw) * slope + inter;
    data[i] = val;
    // Check finiteness AFTER Float32Array narrowing so FLOAT64 overflow (e.g. 1e100 -> Infinity) is caught.
    if (!Number.isFinite(data[i])) {
      throw new Error('The image contains non-finite or float32-overflowing intensities.');
    }
  }

  return {
    data,
    dims,
    affine: header.affine,
    version: header.version,
    affineSource: header.affineSource,
    xyztUnits: header.xyztUnits,
    transforms: header.transforms,
  };
}

/**
 * Async variant for browser workers: supports gzip via bounded DecompressionStream
 * when no synchronous `decompress` callback is supplied.
 */
export async function readNiftiVolumeAsync(
  bufferLike,
  {
    decompress = null,
    maxVoxels = 128 * 1024 * 1024,
    maxDecompressedBytes = 512 * 1024 * 1024,
  } = {},
) {
  let bytes = toUint8(bufferLike);
  if (isGzipBytes(bytes)) {
    if (typeof decompress === 'function') {
      bytes = toUint8(await decompress(bytes, { maxOutputLength: maxDecompressedBytes }));
    } else if (typeof DecompressionStream === 'function') {
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
      const reader = stream.getReader();
      const chunks = [];
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxDecompressedBytes) {
          await reader.cancel().catch(() => {});
          throw new Error(`Decompressed NIfTI exceeds maximum allowed size (${maxDecompressedBytes} bytes).`);
        }
        chunks.push(value);
      }
      const merged = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
      }
      bytes = merged;
    } else {
      throw new Error('Compressed NIfTI input requires DecompressionStream or a decompress function.');
    }
  }
  return readNiftiVolume(bytes, { maxVoxels, maxDecompressedBytes });
}

function isFloat32Finite(value) {
  return Number.isFinite(value) && Number.isFinite(Math.fround(value));
}

function affineNeedsNifti2(dims, affine, transforms) {
  if (dims.some((d) => d > 32767)) return true;
  if (affine.flat().some((v) => !isFloat32Finite(v))) return true;
  if (transforms) {
    const fields = [
      transforms.pixdim0,
      ...transforms.pixDims,
      transforms.quaternB,
      transforms.quaternC,
      transforms.quaternD,
      transforms.qoffsetX,
      transforms.qoffsetY,
      transforms.qoffsetZ,
      ...transforms.srowX,
      ...transforms.srowY,
      ...transforms.srowZ,
    ];
    if (fields.some((v) => !isFloat32Finite(v))) return true;
  }
  return false;
}

/**
 * Write a 3D NIfTI-1 or NIfTI-2 volume.
 * When `transforms` is supplied (from `readNiftiVolume`), BOTH qform and sform
 * transforms and xyzt_units are preserved verbatim.
 * When `version` is omitted/null, NIfTI-2 is chosen automatically if the source
 * was NIfTI-2, any dimension exceeds 32767, or affine/transform values overflow float32.
 */
export function writeNiftiVolume(
  { data, dims, affine, transforms = null, version = null },
  description = '',
) {
  const format = WRITE_TYPES.get(data?.constructor);
  if (!format) {
    throw new Error(`Unsupported output voxel array type: ${data?.constructor?.name ?? typeof data}`);
  }
  if (!Array.isArray(dims) || dims.length !== 3 || dims.some((d) => !Number.isInteger(d) || d < 1)) {
    throw new Error(`Invalid output NIfTI dimensions: ${String(dims)}`);
  }
  if (data.length !== dims[0] * dims[1] * dims[2]) {
    throw new Error(`Voxel count ${data.length} does not match dimensions ${dims.join('x')}.`);
  }
  if (affine.flat().some((v) => !Number.isFinite(v))) {
    throw new Error('Output NIfTI affine contains non-finite values.');
  }

  const needsV2 = affineNeedsNifti2(dims, affine, transforms);
  const chosenVersion = version ?? (needsV2 ? 2 : 1);
  if (chosenVersion === 1 && needsV2) {
    throw new Error('Affine or dimensions exceed NIfTI-1 finite float32 / int16 limits.');
  }
  if (chosenVersion !== 1 && chosenVersion !== 2) {
    throw new Error(`Unsupported NIfTI version: ${chosenVersion}`);
  }

  const colNorms = [0, 1, 2].map((col) =>
    Math.hypot(affine[0][col], affine[1][col], affine[2][col]),
  );
  const tx = transforms
    ? {
        qformCode: transforms.qformCode,
        sformCode: transforms.sformCode,
        pixdim0: transforms.pixdim0,
        pixDims: transforms.pixDims,
        quaternB: transforms.quaternB,
        quaternC: transforms.quaternC,
        quaternD: transforms.quaternD,
        qoffsetX: transforms.qoffsetX,
        qoffsetY: transforms.qoffsetY,
        qoffsetZ: transforms.qoffsetZ,
        srowX: transforms.srowX,
        srowY: transforms.srowY,
        srowZ: transforms.srowZ,
        xyztUnits: transforms.xyztUnits,
      }
    : {
        qformCode: 0,
        sformCode: 1,
        pixdim0: 1,
        pixDims: colNorms,
        quaternB: 0,
        quaternC: 0,
        quaternD: 0,
        qoffsetX: 0,
        qoffsetY: 0,
        qoffsetZ: 0,
        srowX: affine[0],
        srowY: affine[1],
        srowZ: affine[2],
        xyztUnits: 2,
      };

  const descBytes = new TextEncoder().encode(description).slice(0, 79);
  const headerSize = chosenVersion === 2 ? 544 : 352;
  const buffer = new ArrayBuffer(headerSize + data.length * format.bytes);
  const view = new DataView(buffer);

  if (chosenVersion === 1) {
    view.setInt32(0, 348, true);
    view.setInt16(40, 3, true);
    view.setInt16(42, dims[0], true);
    view.setInt16(44, dims[1], true);
    view.setInt16(46, dims[2], true);
    for (let i = 4; i < 8; i += 1) view.setInt16(40 + i * 2, 1, true);
    view.setInt16(70, format.code, true);
    view.setInt16(72, format.bitpix, true);
    view.setFloat32(76, tx.pixdim0, true);
    view.setFloat32(80, tx.pixDims[0], true);
    view.setFloat32(84, tx.pixDims[1], true);
    view.setFloat32(88, tx.pixDims[2], true);
    view.setFloat32(108, headerSize, true);
    view.setFloat32(112, 1, true);
    view.setFloat32(116, 0, true);
    view.setUint8(123, tx.xyztUnits & 0xff);
    new Uint8Array(buffer, 148, 80).set(descBytes);
    view.setInt16(252, tx.qformCode, true);
    view.setInt16(254, tx.sformCode, true);
    view.setFloat32(256, tx.quaternB, true);
    view.setFloat32(260, tx.quaternC, true);
    view.setFloat32(264, tx.quaternD, true);
    view.setFloat32(268, tx.qoffsetX, true);
    view.setFloat32(272, tx.qoffsetY, true);
    view.setFloat32(276, tx.qoffsetZ, true);
    for (let c = 0; c < 4; c += 1) {
      view.setFloat32(280 + c * 4, tx.srowX[c], true);
      view.setFloat32(296 + c * 4, tx.srowY[c], true);
      view.setFloat32(312 + c * 4, tx.srowZ[c], true);
    }
    new Uint8Array(buffer, 344, 4).set([0x6e, 0x2b, 0x31, 0x00]); // "n+1\0"
  } else {
    view.setInt32(0, 540, true);
    new Uint8Array(buffer, 4, 8).set([0x6e, 0x2b, 0x32, 0x00, 0x0d, 0x0a, 0x1a, 0x0a]); // "n+2\0\r\n\x1a\n"
    view.setInt16(12, format.code, true);
    view.setInt16(14, format.bitpix, true);
    view.setBigInt64(16, 3n, true);
    view.setBigInt64(24, BigInt(dims[0]), true);
    view.setBigInt64(32, BigInt(dims[1]), true);
    view.setBigInt64(40, BigInt(dims[2]), true);
    for (let i = 4; i < 8; i += 1) view.setBigInt64(16 + i * 8, 1n, true);
    view.setFloat64(104, tx.pixdim0, true);
    view.setFloat64(112, tx.pixDims[0], true);
    view.setFloat64(120, tx.pixDims[1], true);
    view.setFloat64(128, tx.pixDims[2], true);
    view.setBigInt64(168, BigInt(headerSize), true);
    view.setFloat64(176, 1, true);
    view.setFloat64(184, 0, true);
    new Uint8Array(buffer, 240, 80).set(descBytes);
    view.setInt32(344, tx.qformCode, true);
    view.setInt32(348, tx.sformCode, true);
    view.setFloat64(352, tx.quaternB, true);
    view.setFloat64(360, tx.quaternC, true);
    view.setFloat64(368, tx.quaternD, true);
    view.setFloat64(376, tx.qoffsetX, true);
    view.setFloat64(384, tx.qoffsetY, true);
    view.setFloat64(392, tx.qoffsetZ, true);
    for (let c = 0; c < 4; c += 1) {
      view.setFloat64(400 + c * 8, tx.srowX[c], true);
      view.setFloat64(432 + c * 8, tx.srowY[c], true);
      view.setFloat64(464 + c * 8, tx.srowZ[c], true);
    }
    view.setInt32(500, tx.xyztUnits, true);
  }

  if (format.bytes === 1 && data instanceof Uint8Array) {
    new Uint8Array(buffer, headerSize).set(data);
  } else {
    for (let i = 0; i < data.length; i += 1) {
      view[format.method](headerSize + i * format.bytes, data[i], true);
    }
  }
  return buffer;
}
