/**
 * Tests for MaskController's custom-mask upload path.
 *
 * An uploaded mask has to reach `currentMaskData` — that is what gates the run button, what is
 * handed to the worker as `customMaskBuffer`, and what the overlay draws.
 */

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
    expect(controller.getMaskDims()).toEqual(DIMS);
    expect(controller.getVoxelSize()).toEqual([0.25, 0.25, 1]);
  });

  it('reports a missing file rather than throwing', async () => {
    const result = await controller.loadMaskFromFile(null);
    expect(result.ok).toBe(false);
    expect(controller.currentMaskData).toBeNull();
  });
});
