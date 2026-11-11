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
function makeNiftiFile(name, dims, datatype, values, pixDims = [1, 0.5, 0.5, 2], littleEndian = true) {
  const bytesPerVoxel = { 2: 1, 4: 2, 16: 4, 512: 2 }[datatype];
  const n = dims[0] * dims[1] * dims[2];
  const buffer = new ArrayBuffer(352 + n * bytesPerVoxel);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  view.setInt32(0, 348, littleEndian);          // sizeof_hdr
  view.setInt16(40, 3, littleEndian);           // dim[0]
  view.setInt16(42, dims[0], littleEndian);
  view.setInt16(44, dims[1], littleEndian);
  view.setInt16(46, dims[2], littleEndian);
  view.setInt16(48, 1, littleEndian);           // dim[4]
  view.setInt16(70, datatype, littleEndian);
  view.setInt16(72, bytesPerVoxel * 8, littleEndian);
  for (let i = 0; i < 4; i++) view.setFloat32(76 + i * 4, pixDims[i], littleEndian);
  view.setFloat32(108, 352, littleEndian);      // vox_offset
  view.setFloat32(112, 1, littleEndian);        // scl_slope
  view.setFloat32(116, 0, littleEndian);        // scl_inter
  bytes[344] = 0x6E; bytes[345] = 0x2B; bytes[346] = 0x31; // "n+1"

  for (let i = 0; i < n; i++) {
    const v = values[i] ?? 0;
    const off = 352 + i * bytesPerVoxel;
    if (datatype === 2) bytes[off] = v;
    else if (datatype === 4) view.setInt16(off, v, littleEndian);
    else if (datatype === 512) view.setUint16(off, v, littleEndian);
    else view.setFloat32(off, v, littleEndian);
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
        .rejects.toThrow(/Echo 2 \(e2_small\.nii\) is 4x4x1 but echo 1 \(e1\.nii\) is 4x4x2/);
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

    it("sends the magnitude header's affine, which BET takes FSL's left-right order from", async () => {
      let sent;
      const listeners = new Set();
      controller.initializeWorker = async () => {};
      controller.getWorker = () => ({
        addEventListener: (_, fn) => listeners.add(fn),
        removeEventListener: (_, fn) => listeners.delete(fn),
        postMessage: (msg) => {
          sent = msg.data;
          queueMicrotask(() => listeners.forEach(fn => fn({ data: { type: 'applyMaskOpsComplete', maskData: msg.data.mask } })));
        },
      });
      // A sform (code 2) with a positive determinant: a neurologically stored image.
      const header = new ArrayBuffer(352);
      const view = new DataView(header);
      view.setInt16(254, 2, true);
      [[1.5, 0, 0, -90], [0, 1.5, 0.1, -110], [0, 0, 2, -60]].forEach((row, r) =>
        row.forEach((v, c) => view.setFloat32(280 + 16 * r + 4 * c, v, true)));
      controller.magnitudeFileBytes = header;

      await controller.applyMaskOps('erode:1');
      expect(sent.affine).toEqual([1.5, 0, 0, -90, 0, 1.5, Math.fround(0.1), -110, 0, 0, 2, -60, 0, 0, 0, 1]);

      controller.magnitudeFileBytes = null;
      await controller.applyMaskOps('erode:1');
      expect(sent.affine).toEqual([]);
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

/**
 * Every volume one run combines has to sit on the same voxel grid.
 *
 * The failures are quiet rather than loud. Reading past a shorter echo yields `undefined`, and
 * `undefined * undefined` is NaN, which poisons the whole volume while leaving its length correct
 * — so bias correction accepts it, qsm-core's robust_mask finds no finite samples, and the user
 * gets an empty mask with no error anywhere. A transposed echo of the same voxel count is quieter
 * still: it passes a length check and is then combined across mismatched axes. See issue #117.
 */
describe('MaskController.combineMagnitudeRSS', () => {
  const DIMS = [4, 4, 2];
  const N = DIMS[0] * DIMS[1] * DIMS[2];
  let controller;
  let messages;

  beforeEach(() => {
    messages = [];
    controller = new MaskController({
      nv: { volumes: [{}] },
      updateOutput: (message) => messages.push(message),
      setProgress: () => {},
      config: {},
    });
  });

  /** A magnitude echo of `dims`, every voxel `value`. */
  function echo(name, value, dims = DIMS, pixDims = [1, 0.5, 0.5, 2]) {
    const n = dims[0] * dims[1] * dims[2];
    return { file: makeNiftiFile(name, dims, 16, new Float32Array(n).fill(value), pixDims) };
  }

  it('rejects a shorter later echo instead of returning NaN', async () => {
    await expect(controller.combineMagnitudeRSS([
      echo('e1.nii', 3),
      echo('e2.nii', 4, [4, 4, 1]),   // half the slices
    ])).rejects.toThrow(/Echo 2 \(e2\.nii\) is 4x4x1 but echo 1 \(e1\.nii\) is 4x4x2/);
  });

  it('rejects a longer later echo too', async () => {
    await expect(controller.combineMagnitudeRSS([
      echo('e1.nii', 3, [4, 4, 1]),
      echo('e2.nii', 4),
    ])).rejects.toThrow(/Echo 2 \(e2\.nii\) is 4x4x2 but echo 1 \(e1\.nii\) is 4x4x1/);
  });

  it('rejects a transposed echo that a voxel count alone would accept', async () => {
    // 4x4x2 and 2x4x4 are both 32 voxels: a length check passes and the voxels are then summed
    // across mismatched axes, which is wrong without ever being undefined.
    await expect(controller.combineMagnitudeRSS([
      echo('e1.nii', 3),
      echo('e2.nii', 4, [2, 4, 4]),
    ])).rejects.toThrow(/Echo 2 \(e2\.nii\) is 2x4x4 but echo 1 \(e1\.nii\) is 4x4x2/);
  });

  it('names the first offending echo when several disagree', async () => {
    await expect(controller.combineMagnitudeRSS([
      echo('e1.nii', 1),
      echo('e2.nii', 2),
      echo('e3.nii', 3, [2, 2, 2]),
    ])).rejects.toThrow(/Echo 3 \(e3\.nii\)/);
  });

  it('warns but still combines when only the voxel spacing disagrees', async () => {
    // Same matrix size, thicker slices: the combination is coherent voxel-for-voxel, so refusing
    // it would reject headers that converters disagree about today. Say so instead.
    const result = await controller.combineMagnitudeRSS([
      echo('e1.nii', 3),
      echo('e2.nii', 4, DIMS, [1, 0.5, 0.5, 4]),
    ]);
    for (const v of result) expect(v).toBeCloseTo(5, 6);
    expect(messages.some(m => /^Warning: Echo 2 \(e2\.nii\) has the same matrix size as echo 1 \(e1\.nii\) but a different orientation, origin, or voxel spacing/.test(m))).toBe(true);
  });

  it('combines equivalent little- and big-endian echoes on the same physical grid', async () => {
    const little = makeNiftiFile('little.nii', DIMS, 16, new Float32Array(N).fill(3));
    const big = makeNiftiFile('big.nii', DIMS, 16, new Float32Array(N).fill(4), [1, 0.5, 0.5, 2], false);
    const result = await controller.combineMagnitudeRSS([{ file: little }, { file: big }]);
    expect(Array.from(result)).toEqual(Array(N).fill(5));
  });

  it('passes a single echo through untouched', async () => {
    const result = await controller.combineMagnitudeRSS([echo('e1.nii', 7)]);
    expect(result.length).toBe(N);
    for (const v of result) expect(v).toBeCloseTo(7, 6);
  });

  it('names a file whose data is shorter than its header claims', async () => {
    // Without this the reads below index past the end of the DataView, which raises a bare
    // offset-out-of-bounds naming nothing.
    const full = await echo('e1.nii', 3).file.arrayBuffer();
    const short = { name: 'short.nii', arrayBuffer: async () => full.slice(0, 352 + 16 * 4) };
    await expect(controller.readNiftiData(short)).rejects.toThrow(
      /short\.nii is truncated: its header describes 4x4x2 voxels of 32-bit data, which needs 480 bytes, but the file has 416/
    );
  });
});

/**
 * The ROMEO quality map indexes the magnitude and the second phase echo to the *first phase
 * echo's* dimensions inside qsm-core, with no length check on either side of the WASM boundary.
 * A magnitude smaller than the phase indexes out of bounds there and surfaces as a panic naming
 * nothing — the mismatch QSM.rs#70 reported.
 */
describe('MaskController.computeVoxelQualityMap', () => {
  const DIMS = [4, 4, 2];
  let controller;
  let posted;

  beforeEach(() => {
    posted = [];
    controller = new MaskController({
      nv: { volumes: [{}] },
      initializeWorker: async () => {},
      getWorker: () => ({
        subscribe: () => () => {},
        // Clone like a real postMessage, so a transfer list holding anything but buffers throws.
        send: (message, transfer) => posted.push(structuredClone(message, { transfer })),
      }),
      updateOutput: () => {},
      setProgress: () => {},
      config: {},
    });
  });

  function volume(name, dims = DIMS) {
    const n = dims[0] * dims[1] * dims[2];
    return { file: makeNiftiFile(name, dims, 16, new Float32Array(n).fill(1)) };
  }

  it('rejects a magnitude that is not on the phase grid', async () => {
    await expect(controller.computeVoxelQualityMap(
      [volume('ph1.nii')], [volume('mag1.nii', [2, 4, 4])], [10, 20]
    )).rejects.toThrow(
      /Magnitude echo 1 \(mag1\.nii\) is 2x4x4 but phase echo 1 \(ph1\.nii\) is 4x4x2/
    );
    expect(posted).toHaveLength(0);
  });

  it('rejects a second phase echo that is not on the first echo grid', async () => {
    await expect(controller.computeVoxelQualityMap(
      [volume('ph1.nii'), volume('ph2.nii', [4, 4, 1])], [volume('mag1.nii')], [10, 20]
    )).rejects.toThrow(
      /Phase echo 2 \(ph2\.nii\) is 4x4x1 but phase echo 1 \(ph1\.nii\) is 4x4x2/
    );
    expect(posted).toHaveLength(0);
  });

  it('sends voxel data, not volume objects, when every input shares the grid', async () => {
    let failure;
    controller.computeVoxelQualityMap(
      [volume('ph1.nii'), volume('ph2.nii')], [volume('mag1.nii')], [10, 20]
    ).catch((e) => { failure = e; });        // no worker reply in this test; the job is the assertion
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(failure).toBeUndefined();

    expect(posted).toHaveLength(1);
    expect(posted[0].type).toBe('voxelQuality');
    expect(posted[0].data.phase).toHaveLength(32);
    expect(posted[0].data.phase2).toHaveLength(32);
    expect(posted[0].data.mag).toHaveLength(32);
    expect([posted[0].data.nx, posted[0].data.ny, posted[0].data.nz]).toEqual(DIMS);
  });
});
