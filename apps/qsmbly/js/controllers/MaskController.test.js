/**
 * Tests for MaskController's custom-mask upload path.
 *
 * An uploaded mask has to reach `currentMaskData` — that is what gates the run button, what is
 * handed to the worker as `customMaskBuffer`, and what the overlay draws.
 */

import { jest } from '@jest/globals';
import zlib from 'node:zlib';
import { MaskController } from './MaskController.js';

/** Build a NIfTI-1 file (header + data) as a File-like object. */
function makeNiftiFile(name, dims, datatype, values, pixDims = [1, 0.5, 0.5, 2]) {
  const bytesPerVoxel = { 2: 1, 4: 2, 16: 4, 512: 2 }[datatype];
  const n = dims[0] * dims[1] * dims[2];
  const buffer = new ArrayBuffer(352 + n * bytesPerVoxel);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  view.setInt32(0, 348, true);          // sizeof_hdr
  view.setInt16(40, 3, true);           // dim[0]
  view.setInt16(42, dims[0], true);
  view.setInt16(44, dims[1], true);
  view.setInt16(46, dims[2], true);
  view.setInt16(48, 1, true);           // dim[4]
  view.setInt16(70, datatype, true);
  view.setInt16(72, bytesPerVoxel * 8, true);
  for (let i = 0; i < 4; i++) view.setFloat32(76 + i * 4, pixDims[i], true);
  view.setFloat32(108, 352, true);      // vox_offset
  view.setFloat32(112, 1, true);        // scl_slope
  view.setFloat32(116, 0, true);        // scl_inter
  bytes[344] = 0x6E; bytes[345] = 0x2B; bytes[346] = 0x31; // "n+1"

  for (let i = 0; i < n; i++) {
    const v = values[i] ?? 0;
    const off = 352 + i * bytesPerVoxel;
    if (datatype === 2) bytes[off] = v;
    else if (datatype === 4) view.setInt16(off, v, true);
    else if (datatype === 512) view.setUint16(off, v, true);
    else view.setFloat32(off, v, true);
  }

  return { name, arrayBuffer: async () => buffer };
}

describe('MaskController.loadMaskFromFile', () => {
  const DIMS = [4, 4, 2];
  const N = DIMS[0] * DIMS[1] * DIMS[2];
  let controller;
  let savedDocument;
  let savedURL;

  beforeEach(() => {
    savedDocument = global.document;
    savedURL = global.URL;
    global.document = { getElementById: () => null };
    global.URL = { createObjectURL: () => 'blob:mask', revokeObjectURL: () => {} };

    controller = new MaskController({
      nv: {
        volumes: [{}],
        drawBitmap: null,
        removeVolumeByIndex: async () => {},
        addVolumeFromUrl: async () => {},
        updateGLVolume: () => {},
      },
      updateOutput: () => {},
      setProgress: () => {},
      config: {},
    });
  });

  afterEach(() => {
    global.document = savedDocument;
    global.URL = savedURL;
  });

  /** The image the pipeline runs on, used as the reference grid. */
  function referenceImage(dims = DIMS) {
    const n = dims[0] * dims[1] * dims[2];
    return makeNiftiFile('mag.nii', dims, 16, new Float32Array(n).fill(100), [1, 0.5, 0.5, 2]);
  }

  it('previews an unaccepted mask over restored anatomy using its original header', async () => {
    const file = makeNiftiFile('different-grid.nii', DIMS, 16, [0, 0.4, 1, 2]);
    const header = await file.arrayBuffer();
    new DataView(header).setFloat32(280, 20, true);
    const calls = [];
    controller.readNiftiHeader = async () => header;
    controller.readNiftiData = async () => {
      calls.push('decode');
      controller.nv.volumes = [{ name: 'temporary mask' }];
      return [0, 0.4, 1, 2];
    };
    controller.displayCurrentMask = async (data, previewHeader) => {
      calls.push('overlay');
      expect(controller.nv.volumes[0].name).toBe('anatomy');
      expect(previewHeader).toBe(header);
      expect(Array.from(data)).toEqual([0, 0, 1, 1]);
    };
    await controller.previewUploadedMask(file, async () => {
      calls.push('reference');
      controller.nv.volumes = [{ name: 'anatomy' }];
    });
    expect(calls).toEqual(['decode', 'reference', 'overlay']);
    expect(controller.currentMaskData).toBeFalsy();
    expect(controller.originalMaskData).toBeFalsy();
  });

  it('adopts a matching mask and binarises it', async () => {
    // uint16, as FSL/BET masks and the Bruker mouse mask come out
    const values = new Uint16Array(N);
    values.fill(0);
    values[0] = 1;
    values[1] = 255;
    const mask = makeNiftiFile('brain_mask.nii', DIMS, 512, values);

    const result = await controller.loadMaskFromFile(mask, referenceImage());

    expect(result.ok).toBe(true);
    expect(controller.currentMaskData).toBeInstanceOf(Float32Array);
    expect(controller.currentMaskData.length).toBe(N);
    expect(controller.currentMaskData[0]).toBe(1);
    expect(controller.currentMaskData[1]).toBe(1);   // 255 binarises to 1
    expect(controller.currentMaskData[2]).toBe(0);
    // originalMaskData is a copy, so refinements can reset to the uploaded mask
    expect(controller.originalMaskData).not.toBe(controller.currentMaskData);
    expect(Array.from(controller.originalMaskData)).toEqual(Array.from(controller.currentMaskData));
  });

  it('rejects a 4D mask instead of keeping only its first volume', async () => {
    const values = new Uint8Array(N * 2).fill(1);
    const mask = makeNiftiFile('brain_mask_4d.nii', DIMS, 2, values);
    const buffer = await mask.arrayBuffer();
    const view = new DataView(buffer);
    view.setInt16(40, 4, true);
    view.setInt16(48, 2, true);

    const result = await controller.loadMaskFromFile(mask, referenceImage());

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/2 volumes/);
    expect(controller.currentMaskData).toBeNull();
  });

  it('rejects matching dimensions with different voxel spacing', async () => {
    const values = new Uint16Array(N).fill(1);
    const mask = makeNiftiFile('brain_mask.nii', DIMS, 512, values, [1, 9, 9, 9]);

    const result = await controller.loadMaskFromFile(mask, referenceImage());

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/orientation|origin|spacing/);
    expect(controller.currentMaskData).toBeNull();
  });

  it('rejects a mask on a different grid', async () => {
    const other = [4, 4, 3];
    const values = new Uint16Array(other[0] * other[1] * other[2]).fill(1);
    const mask = makeNiftiFile('wrong_grid.nii', other, 512, values);

    const result = await controller.loadMaskFromFile(mask, referenceImage());

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/4x4x3.*4x4x2/);
    expect(controller.currentMaskData).toBeNull();
  });


  it('rejects a flipped mask even when dimensions and spacing match', async () => {
    const mask = makeNiftiFile('flipped.nii', DIMS, 512, new Uint16Array(N).fill(1));
    const header = new DataView(await mask.arrayBuffer());
    header.setInt16(252, 1, true);
    header.setFloat32(264, 1, true); // qform: 180-degree rotation around Z
    const result = await controller.loadMaskFromFile(mask, referenceImage());
    expect(result.ok).toBe(false);
    expect(result.alignmentMismatch).toBe(true);
    expect(controller.currentMaskData).toBeNull();
  });

  it('clears a previously accepted mask when a replacement has incompatible geometry', async () => {
    const valid = makeNiftiFile('valid.nii', DIMS, 512, new Uint16Array(N).fill(1));
    expect((await controller.loadMaskFromFile(valid, referenceImage())).ok).toBe(true);
    const invalid = makeNiftiFile('invalid.nii', DIMS, 512, new Uint16Array(N).fill(1), [1, 9, 9, 9]);
    expect((await controller.loadMaskFromFile(invalid, referenceImage())).ok).toBe(false);
    expect(controller.currentMaskData).toBeNull();
    expect(controller.originalMaskData).toBeNull();
  });

  it('checks the current reference file even when an old header is cached', async () => {
    const mask = makeNiftiFile('mask.nii', DIMS, 512, new Uint16Array(N).fill(1));
    controller.magnitudeFileBytes = (await mask.arrayBuffer()).slice(0, 352);
    const other = makeNiftiFile('other.nii', DIMS, 16, new Float32Array(N), [1, 1, 1, 1]);
    expect((await controller.loadMaskFromFile(mask, other)).ok).toBe(false);
  });

  it('rejects an empty mask', async () => {
    const mask = makeNiftiFile('empty.nii', DIMS, 512, new Uint16Array(N));

    const result = await controller.loadMaskFromFile(mask, referenceImage());

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/no non-zero voxels/);
    expect(controller.currentMaskData).toBeNull();
  });

  it('falls back to the mask\'s own header when there is no reference image', async () => {
    const values = new Uint16Array(N).fill(1);
    const mask = makeNiftiFile('brain_mask.nii', DIMS, 512, values, [1, 0.25, 0.25, 1]);

    const result = await controller.loadMaskFromFile(mask, null);

    expect(result.ok).toBe(true);
    expect(controller.maskDims).toEqual(DIMS);
    expect(controller.voxelSize).toEqual([0.25, 0.25, 1]);
  });

  it('reports a missing file rather than throwing', async () => {
    const result = await controller.loadMaskFromFile(null);
    expect(result.ok).toBe(false);
    expect(controller.currentMaskData).toBeNull();
  });
});

describe('MaskController error paths', () => {
  const DIMS = [4, 4, 2];
  const N = DIMS[0] * DIMS[1] * DIMS[2];
  let controller;
  let log;
  let savedDocument;

  beforeEach(() => {
    savedDocument = global.document;
    global.document = { getElementById: () => null };
    log = [];
    controller = new MaskController({
      nv: { volumes: [] },
      updateOutput: (m) => log.push(m),
      setProgress: () => {},
      initializeWorker: async () => {},
      config: {},
    });
  });

  afterEach(() => {
    global.document = savedDocument;
  });

  describe('combineMagnitudeRSS', () => {
    it('combines echoes of the same size', async () => {
      const a = makeNiftiFile('e1.nii', DIMS, 16, new Float32Array(N).fill(3));
      const b = makeNiftiFile('e2.nii', DIMS, 16, new Float32Array(N).fill(4));
      const rss = await controller.combineMagnitudeRSS([{ file: a }, { file: b }]);
      expect(rss.length).toBe(N);
      expect(rss[0]).toBeCloseTo(5);
    });

    it('names the echo whose matrix size differs instead of producing NaNs', async () => {
      const a = makeNiftiFile('e1.nii', DIMS, 16, new Float32Array(N).fill(3));
      const b = makeNiftiFile('e2_small.nii', [4, 4, 1], 16, new Float32Array(N / 2).fill(4));
      await expect(controller.combineMagnitudeRSS([{ file: a }, { file: b }]))
        .rejects.toThrow(/Echo 2 \(e2_small\.nii\) has 16 voxels but echo 1 has 32/);
    });
  });

  describe('computeOtsuThreshold', () => {
    it('returns null for a constant image so callers can bail out', () => {
      controller.preparedMagnitudeData = new Float64Array(N).fill(7);
      expect(controller.computeOtsuThreshold()).toBeNull();
      expect(log.some(m => /Cannot compute threshold/.test(m))).toBe(true);
    });

    it('returns null before Prepare', () => {
      expect(controller.computeOtsuThreshold()).toBeNull();
    });
  });

  describe('runBET', () => {
    const magnitudeFiles = [{ file: { name: 'mag.nii' } }];

    it('reports a failure through onError, not onComplete', async () => {
      controller.initializeWorker = async () => { throw new Error('WASM init failed'); };
      const onComplete = jest.fn();
      const onError = jest.fn();
      await controller.runBET({ magnitudeFiles, betSettings: {}, onComplete, onError });
      expect(onComplete).not.toHaveBeenCalled();
      expect(onError).toHaveBeenCalledWith('WASM init failed');
    });

    it('falls back to onComplete({ error }) when no onError is given', async () => {
      controller.initializeWorker = async () => { throw new Error('WASM init failed'); };
      const onComplete = jest.fn();
      await controller.runBET({ magnitudeFiles, betSettings: {}, onComplete });
      expect(onComplete).toHaveBeenCalledWith({ error: 'WASM init failed' });
    });

    it('reports a mask display failure through onError', async () => {
      controller.displayCurrentMask = async () => { throw new Error('display failed'); };
      const onComplete = jest.fn();
      const onError = jest.fn();
      await controller.handleBETComplete({ maskData: new Float32Array(N), coverage: '0%' }, onComplete, onError);
      expect(onComplete).not.toHaveBeenCalled();
      expect(onError).toHaveBeenCalledWith('display failed');
    });
  });

  describe('applyMaskOps', () => {
    beforeEach(() => {
      controller.currentMaskData = new Float32Array(N).fill(1);
      controller.maskDims = DIMS;
    });

    it('starts a fresh worker when a cancel has nulled the old one', async () => {
      // Stands in for QsmPipelineController: cancel() leaves no channel until initialize() runs.
      let worker = null;
      const listeners = new Set();
      controller.getWorker = () => worker;
      controller.initializeWorker = async () => {
        worker = {
          subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
          send: (msg) => {
            const reply = { type: 'applyMaskOpsComplete', maskData: msg.data.mask };
            queueMicrotask(() => listeners.forEach(fn => fn(reply)));
          },
        };
      };

      await expect(controller.applyMaskOps('erode:1')).resolves.toBe(true);
      expect(listeners.size).toBe(0);
    });

    it('rejects with the init error instead of dereferencing a null worker', async () => {
      controller.getWorker = () => null;
      controller.initializeWorker = async () => { throw new Error('WASM init failed'); };
      await expect(controller.applyMaskOps('erode:1')).rejects.toThrow('WASM init failed');
    });
  });

  describe('applyBiasCorrection', () => {
    it('moves the magnitude to the worker and resolves with the typed-array result', async () => {
      const listeners = new Set();
      let received;
      // The WorkerSession channel QsmPipelineController hands the mask controller.
      const worker = {
        subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
        // Clone like a real postMessage, honouring the transfer list in both directions.
        send: (msg, transfer) => {
          received = structuredClone(msg, { transfer });
          const result = received.data.magnitude.map((v) => v * 2);
          const reply = structuredClone({ type: 'biasCorrection', result }, { transfer: [result.buffer] });
          queueMicrotask(() => listeners.forEach((fn) => fn(reply)));
        },
      };
      controller.initializeWorker = async () => {};
      controller.getWorker = () => worker;
      controller.magnitudeFileBytes = new ArrayBuffer(352);
      const magnitude = new Float64Array([1, 2, 3]);

      const corrected = await controller.applyBiasCorrection(magnitude);

      expect(magnitude.byteLength).toBe(0);
      // (constructor names: structuredClone builds its copies outside jest's realm)
      expect(received.data.magnitude.constructor.name).toBe('Float64Array');
      expect(corrected.constructor.name).toBe('Float64Array');
      expect(Array.from(corrected)).toEqual([2, 4, 6]);
      expect(listeners.size).toBe(0);
    });
  });
});

describe('MaskController NIfTI reading of .nii and .nii.gz', () => {
  const DIMS = [8, 6, 4];
  const N = DIMS[0] * DIMS[1] * DIMS[2];
  const SLOPE = 2.5;
  const INTER = -3;
  let controller;

  beforeEach(() => {
    // No viewer: decoding must not depend on (or touch) NiiVue.
    controller = new MaskController({ nv: null, updateOutput: () => {}, setProgress: () => {}, config: {} });
  });

  /** The same int16 image with a non-identity scale, uncompressed and gzipped. */
  async function scaledPair() {
    const values = Array.from({ length: N }, (_, i) => (i * 37) % 1000 - 500);
    const nii = makeNiftiFile('mag.nii', DIMS, 4, values);
    const buffer = await nii.arrayBuffer();
    const view = new DataView(buffer);
    view.setFloat32(112, SLOPE, true);
    view.setFloat32(116, INTER, true);
    const gz = zlib.gzipSync(new Uint8Array(buffer));
    const niiGz = { name: 'mag.nii.gz', arrayBuffer: async () => gz.buffer.slice(gz.byteOffset, gz.byteOffset + gz.byteLength) };
    return { values, nii, niiGz };
  }

  it('applies scl_slope/scl_inter identically to both', async () => {
    const { values, nii, niiGz } = await scaledPair();

    const plain = await controller.readNiftiData(nii);
    const gzipped = await controller.readNiftiData(niiGz);

    expect(gzipped).toBeInstanceOf(Float64Array);
    expect(Array.from(gzipped)).toEqual(Array.from(plain));
    expect(Array.from(plain)).toEqual(values.map(v => v * SLOPE + INTER));
  });

  it('returns the same 352-byte header for both', async () => {
    const { nii, niiGz } = await scaledPair();

    const plain = new Uint8Array(await controller.readNiftiHeader(nii));
    const gzipped = new Uint8Array(await controller.readNiftiHeader(niiGz));

    expect(gzipped.length).toBe(352);
    expect(Array.from(gzipped)).toEqual(Array.from(plain));
  });

  it('rejects a corrupt gzip stream', async () => {
    const { niiGz } = await scaledPair();
    const truncated = (await niiGz.arrayBuffer()).slice(0, 40);
    await expect(controller.readNiftiData({ name: 'bad.nii.gz', arrayBuffer: async () => truncated }))
      .rejects.toThrow();
  });

  it('adopts a gzipped mask against an uncompressed reference', async () => {
    controller.clearMask = async () => {};
    controller.displayCurrentMask = async () => {};
    const values = new Uint8Array(N);
    values[5] = 1;
    const maskBuffer = await makeNiftiFile('mask.nii', DIMS, 2, values).arrayBuffer();
    const gz = zlib.gzipSync(new Uint8Array(maskBuffer));
    const mask = { name: 'mask.nii.gz', arrayBuffer: async () => gz.buffer.slice(gz.byteOffset, gz.byteOffset + gz.byteLength) };
    const reference = makeNiftiFile('mag.nii', DIMS, 16, new Float32Array(N).fill(100));

    const result = await controller.loadMaskFromFile(mask, reference);

    expect(result.ok).toBe(true);
    expect(controller.maskDims).toEqual(DIMS);
    expect(controller.currentMaskData[5]).toBe(1);
    expect(controller.currentMaskData[4]).toBe(0);
  });
});
