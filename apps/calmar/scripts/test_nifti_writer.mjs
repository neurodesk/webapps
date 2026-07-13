#!/usr/bin/env node --no-warnings
// Phase 33 audit follow-up: round-trip test for web/js/modules/nifti-writer.js.
//
// writeNifti1 is called by every download button in the app (overlap CSV
// is the exception; everything else goes through writeNifti1). Until
// this test it had ZERO unit coverage — a regression that mangled the
// header (e.g. wrong vox_offset, wrong datatype code, byte order flip)
// would silently produce files that parse OK in nifti-reader-js but
// land in a downstream tool (FSL/nibabel) with subtle errors.
//
// Strategy: write a known phantom + affine, decode through
// nifti-reader-js (the same library the app uses for inputs), and
// assert byte-for-byte voxel equality + dim + spacing + affine round-trip.

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { writeNifti1 } =
  await import(path.join(ROOT, 'web/js/modules/nifti-writer.js'));

async function loadNifti() {
  const mod = await import('nifti-reader-js');
  return mod.default || mod;
}

function decodeBack(buf) {
  // The writer returns an ArrayBuffer. nifti-reader-js wants an
  // ArrayBuffer too — pass through.
  return loadNifti().then(nifti => {
    if (!nifti.isNIFTI(buf)) throw new Error('not NIfTI after round-trip');
    const header = nifti.readHeader(buf);
    const imageBuffer = nifti.readImage(header, buf);
    return { nifti, header, imageBuffer };
  });
}

// ---- Test 1: Float32 round-trip preserves voxel values ----
{
  const dims = [4, 5, 3];   // intentionally non-cubic
  const N = dims[0] * dims[1] * dims[2];
  const data = new Float32Array(N);
  for (let i = 0; i < N; i++) data[i] = (i - 30) * 0.5;   // negative + positive + zero
  const buf = writeNifti1(data, {
    dims, spacing: [1.5, 2, 3], description: 'phantom-f32'
  });
  const { nifti, header, imageBuffer } = await decodeBack(buf);

  assert.deepEqual(
    [Number(header.dims[1]), Number(header.dims[2]), Number(header.dims[3])],
    dims,
    'dims must round-trip'
  );
  // NIfTI pixdim[1..3] = spacing.
  for (let i = 0; i < 3; i++) {
    assert.ok(Math.abs(header.pixDims[i + 1] - [1.5, 2, 3][i]) < 1e-6,
      `spacing axis ${i}: got ${header.pixDims[i + 1]}`);
  }
  assert.equal(header.datatypeCode, nifti.NIFTI1.TYPE_FLOAT32, 'datatype code');
  // Voxel values must be bit-equal — Float32 in, Float32 out.
  const out = new Float32Array(imageBuffer);
  assert.equal(out.length, N, 'voxel count');
  for (let i = 0; i < N; i++) {
    assert.equal(out[i], data[i],
      `voxel ${i}: in=${data[i]} out=${out[i]}`);
  }
}

// ---- Test 2: Uint8 round-trip preserves binary mask ----
{
  const dims = [3, 3, 3];
  const N = 27;
  const data = new Uint8Array(N);
  data[0] = 1; data[13] = 1; data[26] = 1;   // sparse pattern
  const buf = writeNifti1(data, {
    dims, spacing: [2, 2, 2], description: 'phantom-u8'
  });
  const { nifti, header, imageBuffer } = await decodeBack(buf);
  assert.equal(header.datatypeCode, nifti.NIFTI1.TYPE_UINT8, 'uint8 datatype');
  const out = new Uint8Array(imageBuffer);
  for (let i = 0; i < N; i++) {
    assert.equal(out[i], data[i], `binary mask voxel ${i}`);
  }
}

// ---- Test 3: explicit affine round-trips through sform ----
{
  const dims = [2, 2, 2];
  const data = new Float32Array(8);
  // Canonical FSL MNI 2 mm orientation (-x flipped, +y, +z, custom origin).
  const flatAffine = [
    -2, 0, 0, 78,
    0, 2, 0, -112,
    0, 0, 2, -50
  ];
  const buf = writeNifti1(data, {
    dims, spacing: [2, 2, 2], affine: flatAffine, description: 'phantom-affine'
  });
  const { nifti, header } = await decodeBack(buf);
  // nifti-reader-js exposes the chosen affine on header.affine.
  // Compare the first 3 rows (the 4th is [0,0,0,1] by NIfTI convention).
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 4; c++) {
      const got = header.affine[r][c];
      const want = flatAffine[r * 4 + c];
      assert.ok(Math.abs(got - want) < 1e-6,
        `affine[${r}][${c}]: got ${got}, want ${want}`);
    }
  }
  // sform_code must be 1 (scanner) per the writer's contract.
  assert.equal(header.sform_code, 1, 'sform_code must be 1');
}

// ---- Test 4: NIfTI-1 magic bytes are correct ----
// Header bytes 344..347 must contain 'n+1\0' for single-file form.
{
  const buf = writeNifti1(new Float32Array(1), { dims: [1, 1, 1] });
  const u8 = new Uint8Array(buf);
  assert.equal(u8[344], 'n'.charCodeAt(0), 'magic[0]');
  assert.equal(u8[345], '+'.charCodeAt(0), 'magic[1]');
  assert.equal(u8[346], '1'.charCodeAt(0), 'magic[2]');
  assert.equal(u8[347], 0, 'magic[3] (NUL)');
  // sizeof_hdr at byte 0 must be 348 (Int32 LE).
  const view = new DataView(buf);
  assert.equal(view.getInt32(0, true), 348, 'sizeof_hdr');
  // vox_offset at byte 108 must be 352 (Float32 LE).
  assert.equal(view.getFloat32(108, true), 352, 'vox_offset');
  // Data must start at byte 352 (header 348 + 4 byte filler).
  assert.equal(buf.byteLength, 352 + 4, '1-voxel Float32 file size');
}

// ---- Test 5: input validation ----
{
  assert.throws(
    () => writeNifti1(new Float32Array(8), { dims: [2, 2] }),
    /dims must be/i,
    'rejects non-3D dims'
  );
  assert.throws(
    () => writeNifti1(new Float32Array(7), { dims: [2, 2, 2] }),
    /data length/i,
    'rejects mismatched length'
  );
  assert.throws(
    () => writeNifti1([1, 2, 3, 4, 5, 6, 7, 8], { dims: [2, 2, 2] }),
    /Float32Array or Uint8Array/i,
    'rejects raw arrays'
  );
}

console.log('nifti-writer OK: Float32 + Uint8 round-trip, affine, magic bytes, validation.');
