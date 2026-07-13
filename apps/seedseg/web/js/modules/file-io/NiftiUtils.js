/**
 * NIfTI Utilities Module
 *
 * Pure functions for parsing and creating NIfTI files.
 */

/**
 * Parse NIfTI header to extract dimensions
 * @param {ArrayBuffer} headerBuffer - 352-byte NIfTI-1 header
 * @returns {Object} Header info: dims, datatype, voxOffset, scaling
 */
export function parseNiftiHeader(headerBuffer) {
  const view = new DataView(headerBuffer);

  // Get dimensions (offset 40)
  const dims = [];
  for (let i = 0; i < 8; i++) {
    dims.push(view.getInt16(40 + i * 2, true));
  }

  // Get voxel sizes (offset 76)
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
 * Check if data is gzip compressed
 * @param {Uint8Array} data - File data
 * @returns {boolean} True if gzipped
 */
export function isGzipped(data) {
  return data[0] === 0x1f && data[1] === 0x8b;
}

/**
 * Check if data is valid NIfTI-1 format
 * @param {Uint8Array} data - Uncompressed file data
 * @returns {boolean} True if valid NIfTI-1
 */
export function isValidNifti1(data) {
  const magic = String.fromCharCode(data[344], data[345], data[346]);
  return magic === 'n+1' || magic === 'ni1';
}

/**
 * Read NIfTI image data from uncompressed buffer
 * @param {Uint8Array} data - Uncompressed NIfTI data
 * @returns {Float64Array} Image data
 */
export function readNiftiImageData(data) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  // Get dimensions
  const dims = [];
  for (let i = 0; i < 8; i++) {
    dims.push(view.getInt16(40 + i * 2, true));
  }
  const nTotal = dims[1] * dims[2] * dims[3];

  // Get datatype and vox_offset
  const datatype = view.getInt16(70, true);
  const voxOffset = view.getFloat32(108, true);

  // Get scaling factors
  const sclSlope = view.getFloat32(112, true) || 1;
  const sclInter = view.getFloat32(116, true) || 0;

  // Read image data starting at vox_offset
  const dataStart = Math.ceil(voxOffset);
  const result = new Float64Array(nTotal);

  // Parse based on datatype
  switch (datatype) {
    case 2: // UINT8
      for (let i = 0; i < nTotal; i++) {
        result[i] = data[dataStart + i] * sclSlope + sclInter;
      }
      break;
    case 4: // INT16
      for (let i = 0; i < nTotal; i++) {
        result[i] = view.getInt16(dataStart + i * 2, true) * sclSlope + sclInter;
      }
      break;
    case 8: // INT32
      for (let i = 0; i < nTotal; i++) {
        result[i] = view.getInt32(dataStart + i * 4, true) * sclSlope + sclInter;
      }
      break;
    case 16: // FLOAT32
      for (let i = 0; i < nTotal; i++) {
        result[i] = view.getFloat32(dataStart + i * 4, true) * sclSlope + sclInter;
      }
      break;
    case 64: // FLOAT64
      for (let i = 0; i < nTotal; i++) {
        result[i] = view.getFloat64(dataStart + i * 8, true) * sclSlope + sclInter;
      }
      break;
    case 512: // UINT16
      for (let i = 0; i < nTotal; i++) {
        result[i] = view.getUint16(dataStart + i * 2, true) * sclSlope + sclInter;
      }
      break;
    default:
      throw new Error(`Unsupported NIfTI datatype: ${datatype}`);
  }

  return result;
}

/**
 * Create a mask NIfTI buffer from mask data using source header as template
 * @param {Float32Array} maskData - Binary mask data
 * @param {ArrayBuffer} sourceHeader - Source NIfTI header buffer (352 bytes)
 * @returns {ArrayBuffer} Complete NIfTI buffer ready for blob creation
 */
export function createMaskNifti(maskData, sourceHeader) {
  const srcView = new DataView(sourceHeader);
  const voxOffset = srcView.getFloat32(108, true);
  const headerSize = Math.ceil(voxOffset);

  // Create buffer: header + mask data as float32
  const dataSize = maskData.length * 4; // 4 bytes per float32
  const buffer = new ArrayBuffer(headerSize + dataSize);
  const destBytes = new Uint8Array(buffer);
  const destView = new DataView(buffer);

  // Copy header
  destBytes.set(new Uint8Array(sourceHeader).slice(0, headerSize));

  // Update datatype to FLOAT32 (16) at offset 70
  destView.setInt16(70, 16, true);
  // Update bitpix to 32 at offset 72
  destView.setInt16(72, 32, true);

  // Make it 3D (remove time dimension if any)
  destView.setInt16(40, 3, true); // dim[0] = 3
  destView.setInt16(48, 1, true); // dim[4] = 1

  // Reset scaling (mask values are 0/1)
  destView.setFloat32(112, 1, true); // scl_slope = 1
  destView.setFloat32(116, 0, true); // scl_inter = 0

  // Copy mask data as float32
  const dataView = new Float32Array(buffer, headerSize);
  dataView.set(maskData);

  return buffer;
}

/**
 * Create a minimal NIfTI header buffer from NiiVue volume
 * Used when original file was gzipped and we need uncompressed header
 * @param {Object} vol - NiiVue volume object
 * @returns {ArrayBuffer} 352-byte NIfTI-1 header
 */
export function createNiftiHeaderFromVolume(vol) {
  // NIfTI-1 header is 348 bytes, data starts at 352 (vox_offset)
  const headerSize = 352;
  const buffer = new ArrayBuffer(headerSize);
  const view = new DataView(buffer);
  const hdr = vol.hdr;

  // sizeof_hdr (offset 0) - must be 348 for NIfTI-1
  view.setInt32(0, 348, true);

  // dim array (offset 40) - 8 int16 values
  const dims = hdr.dims || [3, vol.dims[1], vol.dims[2], vol.dims[3], 1, 1, 1, 1];
  for (let i = 0; i < 8; i++) {
    view.setInt16(40 + i * 2, dims[i] || 0, true);
  }

  // datatype (offset 70) - we'll use FLOAT32 = 16
  view.setInt16(70, 16, true);

  // bitpix (offset 72) - 32 bits for float32
  view.setInt16(72, 32, true);

  // pixdim array (offset 76) - 8 float32 values
  const pixdim = hdr.pixDims || [1, vol.pixDims[1] || 1, vol.pixDims[2] || 1, vol.pixDims[3] || 1, 1, 1, 1, 1];
  for (let i = 0; i < 8; i++) {
    view.setFloat32(76 + i * 4, pixdim[i] || 1, true);
  }

  // vox_offset (offset 108) - where data starts
  view.setFloat32(108, headerSize, true);

  // scl_slope (offset 112) and scl_inter (offset 116)
  view.setFloat32(112, hdr.scl_slope || 1, true);
  view.setFloat32(116, hdr.scl_inter || 0, true);

  // xyzt_units (offset 123) - typically 2 (mm) + 8 (sec) = 10
  view.setUint8(123, 10);

  // qform_code (offset 252) and sform_code (offset 254)
  view.setInt16(252, hdr.qform_code || 1, true);
  view.setInt16(254, hdr.sform_code || 1, true);

  // Affine matrix (srow_x, srow_y, srow_z at offsets 280, 296, 312)
  if (hdr.affine) {
    for (let i = 0; i < 4; i++) {
      view.setFloat32(280 + i * 4, hdr.affine[0][i] || 0, true);  // srow_x
      view.setFloat32(296 + i * 4, hdr.affine[1][i] || 0, true);  // srow_y
      view.setFloat32(312 + i * 4, hdr.affine[2][i] || 0, true);  // srow_z
    }
  }

  // magic (offset 344) - "n+1\0" for NIfTI-1
  view.setUint8(344, 0x6E);  // 'n'
  view.setUint8(345, 0x2B);  // '+'
  view.setUint8(346, 0x31);  // '1'
  view.setUint8(347, 0x00);  // '\0'

  return buffer;
}

/**
 * Create NIfTI buffer from Float64Array data using source header as template
 * @param {Float64Array} imageData - Image data
 * @param {ArrayBuffer} sourceHeader - Source NIfTI header buffer
 * @returns {ArrayBuffer} Complete NIfTI buffer
 */
export function createFloat64Nifti(imageData, sourceHeader) {
  const srcView = new DataView(sourceHeader);
  const voxOffset = srcView.getFloat32(108, true);
  const headerSize = Math.ceil(voxOffset);

  // Create buffer: header + data as float64
  const dataSize = imageData.length * 8; // 8 bytes per float64
  const buffer = new ArrayBuffer(headerSize + dataSize);
  const destBytes = new Uint8Array(buffer);
  const destView = new DataView(buffer);

  // Copy header
  destBytes.set(new Uint8Array(sourceHeader).slice(0, headerSize));

  // Update datatype to FLOAT64 (64) at offset 70
  destView.setInt16(70, 64, true);
  // Update bitpix to 64 at offset 72
  destView.setInt16(72, 64, true);

  // Make it 3D
  destView.setInt16(40, 3, true);
  destView.setInt16(48, 1, true);

  // Copy data
  const dataView = new Float64Array(buffer, headerSize);
  dataView.set(imageData);

  return buffer;
}

/**
 * Extract the header portion of a NIfTI file as a standalone ArrayBuffer.
 * Useful for creating output NIfTIs that share the same spatial metadata.
 * @param {Uint8Array} niftiData - Uncompressed NIfTI file data
 * @returns {ArrayBuffer} Header bytes (up to vox_offset)
 */
export function extractNiftiHeader(niftiData) {
  const view = new DataView(niftiData.buffer, niftiData.byteOffset, niftiData.byteLength);
  const voxOffset = view.getFloat32(108, true);
  const headerSize = Math.ceil(voxOffset);
  const header = new ArrayBuffer(headerSize);
  new Uint8Array(header).set(niftiData.slice(0, headerSize));
  return header;
}
