import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import {
  MAX_VOXELS,
  exactLayerCounts,
  formatProfileCsv,
  gridMismatchRefusal,
  inspectNiftiHeader,
  inspectRimHeader,
  inspectRimValues,
  inspectSignalCaveats,
  layersArguments,
  parseProfileText,
  profileArguments,
  readRawNiftiVoxels,
  volumeBudgetRefusal,
} from '../src/index.js';
import { LAYNII_WASM_SHA256, loadLaynii, readLayniiWasm } from '../src/node.js';

/** Build a valid uncompressed 3D NIfTI-1 volume with explicit qform/sform affine and optional scaling. */
function makeNifti3D({
  dims = [16, 16, 16],
  pixdim = [0.5, 0.5, 0.5],
  datatype = 16,
  sclSlope = 1.0,
  sclInter = 0.0,
  qformCode = 1,
  sformCode = 1,
  offset = [-4.0, -3.0, -2.0],
  staleDim4 = 1,
  fill,
}) {
  const [nx, ny, nz] = dims;
  const nvox = nx * ny * nz;
  const bpe = datatype === 4 ? 2 : 4;
  const voxOffset = 352;
  const buf = new Uint8Array(voxOffset + nvox * bpe);
  const dv = new DataView(buf.buffer);
  dv.setInt32(0, 348, true);
  dv.setInt16(40, 3, true); // ndim = 3
  dv.setInt16(42, nx, true);
  dv.setInt16(44, ny, true);
  dv.setInt16(46, nz, true);
  dv.setInt16(48, staleDim4, true);
  dv.setInt16(70, datatype, true);
  dv.setInt16(72, bpe * 8, true);
  dv.setFloat32(76, 1.0, true); // qfac
  dv.setFloat32(80, pixdim[0], true);
  dv.setFloat32(84, pixdim[1], true);
  dv.setFloat32(88, pixdim[2], true);
  dv.setFloat32(108, voxOffset, true);
  dv.setFloat32(112, sclSlope, true);
  dv.setFloat32(116, sclInter, true);
  dv.setInt16(252, qformCode, true);
  dv.setInt16(254, sformCode, true);
  // qform identity quaternion + offset
  dv.setFloat32(256, 0.0, true);
  dv.setFloat32(260, 0.0, true);
  dv.setFloat32(264, 0.0, true);
  dv.setFloat32(268, offset[0], true);
  dv.setFloat32(272, offset[1], true);
  dv.setFloat32(276, offset[2], true);
  // sform matching diagonal + offset
  if (sformCode > 0) {
    dv.setFloat32(280, pixdim[0], true);
    dv.setFloat32(292, offset[0], true);
    dv.setFloat32(300, pixdim[1], true);
    dv.setFloat32(308, offset[1], true);
    dv.setFloat32(320, pixdim[2], true);
    dv.setFloat32(324, offset[2], true);
  }
  buf.set([0x6e, 0x2b, 0x31, 0x00], 344); // "n+1\0"

  const arr = datatype === 4
    ? new Int16Array(buf.buffer, voxOffset, nvox)
    : new Float32Array(buf.buffer, voxOffset, nvox);
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        arr[x + y * nx + z * nx * ny] = fill(x, y, z);
      }
    }
  }
  return buf;
}

/** Build a synthetic planar cortical ribbon along x (WM border=2 at x=3, GM=3 at x=4..11, CSF border=1 at x=12). */
function makeCorticalSlabRim(dims = [16, 16, 16], extra = {}) {
  return makeNifti3D({
    dims,
    datatype: 4,
    ...extra,
    fill: (x, y, z) => {
      if (y < 2 || y >= dims[1] - 2 || z < 2 || z >= dims[2] - 2) return 0;
      if (x === 3) return 2; // inner GM / WM border
      if (x >= 4 && x <= 11) return 3; // pure GM
      if (x === 12) return 1; // outer GM / CSF border
      return 0;
    },
  });
}

/** Build a linear signal gradient rising from WM (x=3 -> 10) to CSF (x=12 -> 100). */
function makeDepthGradientSignal(dims = [16, 16, 16], extra = {}) {
  return makeNifti3D({
    dims,
    datatype: 16,
    ...extra,
    fill: (x) => x * 10.0,
  });
}

function readTypedVoxels(buf) {
  const hdr = inspectNiftiHeader(buf);
  if (hdr.datatype === 16) return { hdr, data: new Float32Array(buf.buffer, buf.byteOffset + hdr.voxOffset, hdr.voxels) };
  if (hdr.datatype === 4) return { hdr, data: new Int16Array(buf.buffer, buf.byteOffset + hdr.voxOffset, hdr.voxels) };
  if (hdr.datatype === 8) return { hdr, data: new Int32Array(buf.buffer, buf.byteOffset + hdr.voxOffset, hdr.voxels) };
  if (hdr.datatype === 512) return { hdr, data: new Uint16Array(buf.buffer, buf.byteOffset + hdr.voxOffset, hdr.voxels) };
  throw new Error(`Unexpected datatype ${hdr.datatype}`);
}

test('layersArguments and profileArguments build deterministic LayNii CLI flags', () => {
  assert.deepEqual(
    layersArguments({ rim: 'rim.nii', output: 'out.nii', nrLayers: 5, equivol: true, iterSmooth: 200, thickness: true }),
    ['-rim', 'rim.nii', '-nr_layers', '5', '-equivol', '-iter_smooth', '200', '-thickness', '-output', 'out.nii'],
  );
  assert.throws(() => layersArguments({ rim: 'rim.nii', nrLayers: 1 }), /between 2 and 100/);
  assert.throws(() => layersArguments({ rim: 'rim.nii', nrLayers: 3, equivol: true, iterSmooth: 0 }), /between 1 and 2000/);
  assert.deepEqual(
    profileArguments({ input: 'bold.nii', layers: 'layers.nii', output: 'profile.txt' }),
    ['-input', 'bold.nii', '-layers', 'layers.nii', '-output', 'profile.txt'],
  );
});

test('inspectRimValues and inspectRimHeader enforce raw integer labels and identity scaling', () => {
  assert.equal(inspectRimValues(new Int16Array([0, 1, 2, 3, 3])).valid, true);
  assert.equal(inspectRimValues(new Float32Array([0, 1.5, 2, 3])).valid, false);
  assert.equal(inspectRimValues(new Int16Array([0, 1, 2, 4])).valid, false);
  assert.equal(inspectRimValues(new Int16Array([0, 1, 3])).valid, false);
  assert.equal(inspectRimValues(new Int16Array([0, 1, 2])).valid, false);

  const scaledRim = makeCorticalSlabRim([16, 16, 16], { sclSlope: 2.0, sclInter: 0.0 });
  assert.equal(inspectRimHeader(inspectNiftiHeader(scaledRim)).valid, false);
  const shiftedRim = makeCorticalSlabRim([16, 16, 16], { sclSlope: 1.0, sclInter: 1.0 });
  assert.equal(inspectRimHeader(inspectNiftiHeader(shiftedRim)).valid, false);
  const zeroSlopeRim = makeCorticalSlabRim([16, 16, 16], { sclSlope: 0.0, sclInter: 0.0 });
  assert.equal(inspectRimHeader(inspectNiftiHeader(zeroSlopeRim)).valid, true);
});

test('inspectNiftiHeader is rank-aware and gridMismatchRefusal checks dims, pixdim and effective affine', () => {
  // 3D header with stale dim[4]=5 must still be treated as 1 frame when ndim=3.
  const stale3d = makeCorticalSlabRim([16, 16, 16], { staleDim4: 5 });
  const staleHdr = inspectNiftiHeader(stale3d);
  assert.equal(staleHdr.frames, 1);
  assert.equal(volumeBudgetRefusal(staleHdr, 'Rim image'), null);

  // Oversized volume rejected pre-allocation.
  const big = { dims: [300, 300, 100], frames: 1, voxels: 9_000_000 };
  assert.ok(big.voxels > MAX_VOXELS);
  assert.match(volumeBudgetRefusal(big, 'Rim image'), /above the browser limit/);
  assert.match(volumeBudgetRefusal({ dims: [16, 16, 16], frames: 10, voxels: 4096 }, 'Rim image'), /10 volumes/);

  // qform-only rim vs sform+qform signal with identical effective affine must match (like Ding2016).
  const qformRimHdr = inspectNiftiHeader(makeCorticalSlabRim([16, 16, 16], { qformCode: 1, sformCode: 0 }));
  const sformSigHdr = inspectNiftiHeader(makeDepthGradientSignal([16, 16, 16], { qformCode: 1, sformCode: 1 }));
  assert.equal(gridMismatchRefusal(qformRimHdr, sformSigHdr), null);

  // Mismatched matrix dims, pixdim, and affine translation must each be refused.
  assert.match(
    gridMismatchRefusal(qformRimHdr, inspectNiftiHeader(makeDepthGradientSignal([16, 16, 15]))),
    /does not match the rim grid/,
  );
  assert.match(
    gridMismatchRefusal(qformRimHdr, inspectNiftiHeader(makeDepthGradientSignal([16, 16, 16], { pixdim: [0.5, 0.5, 0.8] }))),
    /voxel spacing/,
  );
  assert.match(
    gridMismatchRefusal(qformRimHdr, inspectNiftiHeader(makeDepthGradientSignal([16, 16, 16], { offset: [-4.0, -3.0, 2.0] }))),
    /orientation\/affine/,
  );
});

test('parseProfileText handles scientific-notation voxel counts (>= 1e6) and formatProfileCsv round-trips', () => {
  const rows = parseProfileText(
    '1   33.5 17.3181  1.45824e+06\n2   44.2 12.5000  999999\n3   51.0 10.1250  1.2e+06\n',
  );
  assert.deepEqual(rows, [
    { layer: 1, mean: 33.5, std: 17.3181, voxels: 1458240 },
    { layer: 2, mean: 44.2, std: 12.5, voxels: 999999 },
    { layer: 3, mean: 51.0, std: 10.125, voxels: 1200000 },
  ]);
  assert.equal(
    formatProfileCsv(rows),
    'layer,mean,std,voxels\n1,33.5,17.3181,1458240\n2,44.2,12.5,999999\n3,51,10.125,1200000\n',
  );
});

test('inspectSignalCaveats flags non-zero scl_inter and NaN voxels', () => {
  const nanSig = makeNifti3D({
    dims: [8, 8, 8],
    datatype: 16,
    sclInter: 10.0,
    fill: (x, y, z) => (x === 0 && y === 0 && z === 0 ? Number.NaN : 5.0),
  });
  const hdr = inspectNiftiHeader(nanSig);
  const raw = readRawNiftiVoxels(nanSig, hdr);
  const caveats = inspectSignalCaveats(hdr, raw);
  assert.equal(caveats.nonFiniteCount, 1);
  assert.equal(caveats.sclInter, 10.0);
  assert.equal(caveats.warnings.length, 2);
});

test('pinned WASM binary matches SHA-256 and runs LN2_LAYERS + LN2_PROFILE on synthetic cortical slab', async () => {
  const bytes = await readLayniiWasm();
  assert.ok(bytes.byteLength > 100_000);
  assert.equal(LAYNII_WASM_SHA256.length, 64);

  const logs = [];
  const runner = await loadLaynii({ onLog: (line) => logs.push(line) });
  const rim = gzipSync(makeCorticalSlabRim());
  const signal = gzipSync(makeDepthGradientSignal());

  const result = await runner.runLayersAndProfile({
    rim,
    signal,
    nrLayers: 4,
    equivol: true,
    iterSmooth: 20,
    thickness: true,
    equalCounts: true,
  });

  assert.ok(logs.some((line) => line.includes('LN2_LAYERS')));
  assert.ok(logs.some((line) => line.includes('LN2_PROFILE')));

  const eqLayers = readTypedVoxels(result.layersEquidist);
  const evLayers = readTypedVoxels(result.layersEquivol);
  const metric = readTypedVoxels(result.metricEquidist);
  const thickness = readTypedVoxels(result.thickness);

  assert.deepEqual(eqLayers.hdr.dims, [16, 16, 16]);
  assert.deepEqual(evLayers.hdr.dims, [16, 16, 16]);
  assert.ok(result.midGmEquivol && result.midGmEquivol.byteLength > 348);

  // Verify sform affine translation preserved in output NIfTI header.
  const outDv = new DataView(result.layersEquidist.buffer, result.layersEquidist.byteOffset, 348);
  assert.equal(outDv.getFloat32(292, true), -4.0);
  assert.equal(outDv.getFloat32(308, true), -3.0);
  assert.equal(outDv.getFloat32(324, true), -2.0);

  // Layers 1..4 all populated inside the slab, metric in [0, 1], thickness positive.
  const uniqueEq = new Set(eqLayers.data);
  for (const label of [0, 1, 2, 3, 4]) assert.ok(uniqueEq.has(label), `missing equidistant layer ${label}`);
  const uniqueEv = new Set(evLayers.data);
  for (const label of [0, 1, 2, 3, 4]) assert.ok(uniqueEv.has(label), `missing equivolume layer ${label}`);
  assert.ok(Math.max(...metric.data) <= 1.0001 && Math.max(...metric.data) > 0.7);
  assert.ok(Math.max(...thickness.data) > 2.0);

  // Exact counts match exactLayerCounts and profile increases monotonically WM -> CSF.
  assert.equal(result.profile.layerSource, 'equivol');
  assert.equal(result.profile.rows.length, 4);
  const exact = exactLayerCounts(result.layersEquivol);
  for (let i = 0; i < result.profile.rows.length; i++) {
    assert.equal(result.profile.rows[i].voxels, exact.get(result.profile.rows[i].layer));
    if (i > 0) {
      assert.ok(result.profile.rows[i].mean > result.profile.rows[i - 1].mean);
    }
  }

  // With equalCounts only (equivol=false), default profile source stays equidistant.
  const eqResult = await runner.runLayersAndProfile({
    rim,
    signal,
    nrLayers: 3,
    equivol: false,
    equalCounts: true,
  });
  assert.equal(eqResult.profile.layerSource, 'equidist');
});

test('runLayersAndProfile rejects oversized volume header, scaled rim, and malformed NIfTI before allocation', async () => {
  const runner = await loadLaynii();
  const fakeHuge = new Uint8Array(352);
  const dv = new DataView(fakeHuge.buffer);
  dv.setInt32(0, 348, true);
  dv.setInt16(40, 3, true);
  dv.setInt16(42, 400, true);
  dv.setInt16(44, 400, true);
  dv.setInt16(46, 200, true);
  dv.setInt16(48, 1, true);
  dv.setInt16(70, 4, true);
  dv.setInt16(72, 16, true);
  dv.setFloat32(108, 352, true);
  await assert.rejects(
    () => runner.runLayersAndProfile({ rim: fakeHuge }),
    /above the browser limit/,
  );

  const scaledRim = makeCorticalSlabRim([16, 16, 16], { sclSlope: 2.0 });
  await assert.rejects(
    () => runner.runLayersAndProfile({ rim: scaledRim }),
    /non-identity NIfTI intensity scaling/,
  );

  await assert.rejects(
    () => runner.runLayersAndProfile({ rim: new Uint8Array([1, 2, 3, 4]) }),
    /smaller than the 348-byte header/,
  );
});

test('all-options multi-million voxel dense rim stays well inside wasm32 memory budget with exact >1e6 counts', async () => {
  // 128 x 128 x 200 = 3.28M voxels, 2 layers -> >1.4M voxels per layer (triggers scientific notation in LN2_PROFILE text!)
  // Run with equivol + thickness + curvature + equalCounts all enabled to verify headroom and exact counting.
  const dims = [128, 128, 200];
  const rim = makeNifti3D({
    dims,
    datatype: 4,
    fill: (x, y, z) => {
      if (y < 4 || y >= dims[1] - 4 || z < 4 || z >= dims[2] - 4) return 0;
      if (x === 4) return 2;
      if (x >= 5 && x <= 122) return 3;
      if (x === 123) return 1;
      return 0;
    },
  });
  const signal = makeNifti3D({ dims, datatype: 16, fill: (x) => x });
  const runner = await loadLaynii();
  const result = await runner.runLayersAndProfile({
    rim,
    signal,
    nrLayers: 2,
    equivol: true,
    iterSmooth: 5,
    thickness: true,
    curvature: true,
    equalCounts: true,
  });
  const heapMiB = runner.memoryBytes() / (1024 * 1024);
  assert.ok(heapMiB < 1024, `expected peak heap < 1024 MiB for 3.28M dense rim, got ${heapMiB.toFixed(0)} MiB`);
  // Upstream text uses scientific notation (>= 1e6); parsed row voxels must be exact integer > 1,000,000!
  assert.match(result.profile.text, /e\+06/);
  const exact = exactLayerCounts(result.layersEquivol);
  assert.equal(result.profile.rows.length, 2);
  for (const row of result.profile.rows) {
    assert.ok(row.voxels > 1_000_000, `expected > 1e6 voxels, got ${row.voxels}`);
    assert.equal(row.voxels, exact.get(row.layer));
  }
});
