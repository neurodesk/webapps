/**
 * Tests for NiftiUtils module
 */

import {
  parseNiftiHeader,
  isGzipped,
  isValidNifti1,
  readNiftiImageData,
  createMaskNifti,
  createNiftiHeaderFromVolume,
  createFloat64Nifti
} from './NiftiUtils.js';

describe('NiftiUtils', () => {
  // Create a minimal valid NIfTI-1 header buffer for testing
  function createTestHeader(options = {}) {
    const {
      dims = [3, 10, 10, 10, 1, 1, 1, 1],
      datatype = 16, // FLOAT32
      bitpix = 32,
      voxOffset = 352,
      pixDims = [1, 1, 1, 1, 1, 1, 1, 1],
      sclSlope = 1,
      sclInter = 0
    } = options;

    const buffer = new ArrayBuffer(352);
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);

    // sizeof_hdr
    view.setInt32(0, 348, true);

    // dims
    for (let i = 0; i < 8; i++) {
      view.setInt16(40 + i * 2, dims[i], true);
    }

    // datatype
    view.setInt16(70, datatype, true);

    // bitpix
    view.setInt16(72, bitpix, true);

    // pixDims
    for (let i = 0; i < 8; i++) {
      view.setFloat32(76 + i * 4, pixDims[i], true);
    }

    // vox_offset
    view.setFloat32(108, voxOffset, true);

    // scl_slope, scl_inter
    view.setFloat32(112, sclSlope, true);
    view.setFloat32(116, sclInter, true);

    // magic "n+1"
    bytes[344] = 0x6E; // 'n'
    bytes[345] = 0x2B; // '+'
    bytes[346] = 0x31; // '1'
    bytes[347] = 0x00; // '\0'

    return buffer;
  }

  describe('parseNiftiHeader', () => {
    it('should extract dimensions correctly', () => {
      const header = createTestHeader({ dims: [3, 64, 64, 32, 1, 1, 1, 1] });
      const info = parseNiftiHeader(header);

      expect(info.nx).toBe(64);
      expect(info.ny).toBe(64);
      expect(info.nz).toBe(32);
      expect(info.dims[0]).toBe(3);
    });

    it('should extract voxel sizes correctly', () => {
      const header = createTestHeader({ pixDims: [1, 2.0, 2.0, 3.0, 1, 1, 1, 1] });
      const info = parseNiftiHeader(header);

      expect(info.voxelSize[0]).toBeCloseTo(2.0);
      expect(info.voxelSize[1]).toBeCloseTo(2.0);
      expect(info.voxelSize[2]).toBeCloseTo(3.0);
    });

    it('should extract datatype and scaling', () => {
      const header = createTestHeader({ datatype: 64, bitpix: 64, sclSlope: 2.5, sclInter: 10 });
      const info = parseNiftiHeader(header);

      expect(info.datatype).toBe(64);
      expect(info.bitpix).toBe(64);
      expect(info.sclSlope).toBeCloseTo(2.5);
      expect(info.sclInter).toBeCloseTo(10);
    });
  });

  describe('isGzipped', () => {
    it('should detect gzip magic bytes', () => {
      const gzData = new Uint8Array([0x1f, 0x8b, 0x08, 0x00]);
      expect(isGzipped(gzData)).toBe(true);
    });

    it('should return false for non-gzip data', () => {
      const rawData = new Uint8Array([0x00, 0x00, 0x00, 0x00]);
      expect(isGzipped(rawData)).toBe(false);
    });
  });

  describe('isValidNifti1', () => {
    it('should validate n+1 magic', () => {
      const data = new Uint8Array(348);
      data[344] = 0x6E; // 'n'
      data[345] = 0x2B; // '+'
      data[346] = 0x31; // '1'
      expect(isValidNifti1(data)).toBe(true);
    });

    it('should validate ni1 magic', () => {
      const data = new Uint8Array(348);
      data[344] = 0x6E; // 'n'
      data[345] = 0x69; // 'i'
      data[346] = 0x31; // '1'
      expect(isValidNifti1(data)).toBe(true);
    });

    it('should reject invalid magic', () => {
      const data = new Uint8Array(348);
      data[344] = 0x00;
      data[345] = 0x00;
      data[346] = 0x00;
      expect(isValidNifti1(data)).toBe(false);
    });
  });

  describe('createMaskNifti', () => {
    it('should create valid NIfTI buffer from mask', () => {
      const sourceHeader = createTestHeader({ dims: [3, 4, 4, 4, 1, 1, 1, 1] });
      const maskData = new Float32Array(64).fill(1);

      const result = createMaskNifti(maskData, sourceHeader);

      expect(result).toBeInstanceOf(ArrayBuffer);
      // Header (352) + data (64 * 4 = 256)
      expect(result.byteLength).toBe(352 + 256);

      // Check datatype was set to FLOAT32
      const view = new DataView(result);
      expect(view.getInt16(70, true)).toBe(16);
      expect(view.getInt16(72, true)).toBe(32);
    });

    it('should preserve mask values', () => {
      const sourceHeader = createTestHeader({ dims: [3, 2, 2, 2, 1, 1, 1, 1] });
      const maskData = new Float32Array([0, 1, 1, 0, 0, 1, 0, 1]);

      const result = createMaskNifti(maskData, sourceHeader);
      const dataView = new Float32Array(result, 352);

      expect(dataView[0]).toBe(0);
      expect(dataView[1]).toBe(1);
      expect(dataView[2]).toBe(1);
      expect(dataView[3]).toBe(0);
    });
  });

  describe('createFloat64Nifti', () => {
    it('should create valid NIfTI buffer with float64 data', () => {
      const sourceHeader = createTestHeader({ dims: [3, 4, 4, 4, 1, 1, 1, 1] });
      const imageData = new Float64Array(64).fill(3.14159);

      const result = createFloat64Nifti(imageData, sourceHeader);

      expect(result).toBeInstanceOf(ArrayBuffer);
      // Header (352) + data (64 * 8 = 512)
      expect(result.byteLength).toBe(352 + 512);

      // Check datatype was set to FLOAT64
      const view = new DataView(result);
      expect(view.getInt16(70, true)).toBe(64);
      expect(view.getInt16(72, true)).toBe(64);
    });
  });
});
