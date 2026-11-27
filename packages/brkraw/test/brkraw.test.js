import assert from 'node:assert/strict';
import test from 'node:test';
import { zipSync } from 'fflate';
import {
  MAX_CONVERT_BYTES,
  affineToQform,
  decode2dseq,
  encodeNifti1,
  loadBrukerStudy,
  parseJcampText,
  resolveAffines,
  resolveDatatype,
  resolveShape,
  stripJcampString,
  unwrapToScannerXyz,
  wrapToSubjectRas,
} from '../src/index.js';

test('parseJcampText handles comments, shapes, @N*(x) repeats, nested tuples, and angle strings', () => {
  const text = [
    '##TITLE=Parameter List, ParaVision 6.0.1',
    '$$ comment line to ignore',
    '##$VisuCoreDim=2',
    '##$VisuCoreSize=( 2 )',
    '64 64',
    '##$VisuCoreDataSlope=( 4 )',
    '@4*(0.25)',
    '##$VisuFGOrderDescDim=2',
    '##$VisuFGOrderDesc=( 2 )',
    '(3, <FG_ECHO>, <MultiEcho>, 0, 1) (5, <FG_SLICE>, <>, 1, 2)',
    '##$ACQ_protocol_name=( 64 )',
    '<CAMRI_T2^RARE_2D>',
  ].join('\n');

  const p = parseJcampText(text);
  assert.equal(p.header.TITLE, 'Parameter List; ParaVision 6.0.1');
  assert.equal(p.get('VisuCoreDim'), 2);
  assert.deepEqual(p.get('VisuCoreSize'), [64, 64]);
  assert.deepEqual(p.get('VisuCoreDataSlope'), [0.25, 0.25, 0.25, 0.25]);
  assert.deepEqual(p.get('VisuFGOrderDesc'), [
    [3, '<FG_ECHO>', '<MultiEcho>', 0, 1],
    [5, '<FG_SLICE>', '<>', 1, 2],
  ]);
  assert.equal(stripJcampString(p.get('ACQ_protocol_name')), 'CAMRI_T2 RARE_2D');
});

test('unwrapToScannerXyz and wrapToSubjectRas round-trip and handle oblique/coronal/phase flips', () => {
  const acqp = parseJcampText('##$ACQ_scaling_phase=-1\n##$ACQ_protocol_name=( 16 )\n<TestScan>');
  const method = parseJcampText([
    '##$PVM_NSPacks=1',
    '##$PVM_SPackArrNSlices=( 1 )',
    '4',
    '##$PVM_SPackArrSliceDistance=( 1 )',
    '1.0',
    '##$PVM_SPackArrSliceGap=( 1 )',
    '0.2',
    '##$PVM_SPackArrSliceOrient=( 1 )',
    'coronal',
  ].join('\n'));
  const visuPars = parseJcampText([
    '##$VisuCoreDim=2',
    '##$VisuCoreSize=( 2 )',
    '10 8',
    '##$VisuCoreExtent=( 2 )',
    '10.0 8.0',
    '##$VisuCoreOrientation=( 4, 9 )',
    '1 0 0 0 1 0 0 0 1 1 0 0 0 1 0 0 0 1 1 0 0 0 1 0 0 0 1 1 0 0 0 1 0 0 0 1',
    '##$VisuCorePosition=( 4, 3 )',
    '0 0 3.6 0 0 1.2 0 0 0.0 0 0 2.4',
    '##$VisuSubjectType=Quadruped',
    '##$VisuSubjectPosition=Head_Prone',
  ].join('\n'));

  const res = resolveAffines({ acqp, method, visuPars, space: 'subject_ras' });
  assert.equal(res.numSlicePacks, 1);
  assert.deepEqual(res.numSlices, [4]);
  assert.equal(res.effectiveSubjectType, 'Quadruped');
  assert.equal(res.effectiveSubjectPosition, 'Head_Prone');
  const qf = affineToQform(res.affines[0]);
  assert.deepEqual(qf.zooms.map((z) => Number(z.toFixed(4))), [1, 1, 1.2]);

  // Verify unwrap/wrap preserves rigid orthogonality across all Biped/Quadruped poses
  const id = [[1, 0, 0, 5], [0, 1, 0, -3], [0, 0, 1, 2], [0, 0, 0, 1]];
  for (const type of ['Biped', 'Quadruped']) {
    for (const pose of ['Head_Supine', 'Head_Prone', 'Head_Left', 'Head_Right', 'Foot_Supine']) {
      const scan = unwrapToScannerXyz(id, type, pose);
      const ras = wrapToSubjectRas(scan, type, pose);
      const { zooms } = affineToQform(ras);
      assert.deepEqual(zooms.map((z) => Number(z.toFixed(6))), [1, 1, 1]);
    }
  }
});

test('decode2dseq supports bigEndian, z-axis swap (FG_ECHO before FG_SLICE), 2D/3D per-frame scaling, and byte cap', () => {
  const method = parseJcampText('##$PVM_ObjOrderScheme=Interlaced');
  const visuPars = parseJcampText([
    '##$VisuCoreDim=2',
    '##$VisuCoreDimDesc=( 2 )',
    'spatial spatial',
    '##$VisuCoreSize=( 2 )',
    '2 2',
    '##$VisuCoreExtent=( 2 )',
    '2.0 2.0',
    '##$VisuCoreByteOrder=bigEndian',
    '##$VisuCoreWordType=_16BIT_SGN_INT',
    '##$VisuCoreDataSlope=( 6 )',
    '1.0 2.0 3.0 4.0 5.0 6.0',
    '##$VisuCoreDataOffs=( 6 )',
    '0 0 0 0 0 10',
    '##$VisuCoreFrameType=MAGNITUDE_IMAGE',
    '##$VisuFGOrderDescDim=2',
    '##$VisuFGOrderDesc=( 2 )',
    '(2, <FG_ECHO>, <>, 0, 0) (3, <FG_SLICE>, <>, 0, 0)',
  ].join('\n'));

  const dtypeInfo = resolveDatatype(visuPars);
  const shapeInfo = resolveShape(method, visuPars);
  assert.deepEqual(shapeInfo.shape, [2, 2, 2, 3]);
  assert.deepEqual(shapeInfo.shapeDesc, ['spatial', 'spatial', 'echo', 'slice']);

  // 24 int16 big-endian voxels, all value 10
  const raw = new Uint8Array(24 * 2);
  const dv = new DataView(raw.buffer);
  for (let i = 0; i < 24; i++) dv.setInt16(i * 2, 10, false);

  const decoded = decode2dseq(raw, { dtypeInfo, shapeInfo, numSlices: [3] });
  assert.equal(decoded.perFrameScalingApplied, true);
  assert.deepEqual(decoded.shapeDesc, ['spatial', 'spatial', 'slice', 'echo']);
  assert.deepEqual(decoded.packs[0].shape, [2, 2, 3, 2]);
  assert.equal(decoded.packs[0].kind, 'float32');
  assert.equal(decoded.packs[0].sclSlope, 1.0);
  // Frame 0 (echo=0, slice=0) -> 10 * 1 = 10; Frame 5 (echo=1, slice=2) -> 10 * 6 + 10 = 70
  assert.equal(decoded.packs[0].data[0], 10);
  assert.equal(decoded.packs[0].data[23], 70);

  // 3D multi-frame (VisuCoreDim=3, 2 echoes): each frame is a full 3D volume (2*2*3 = 12 voxels)
  const visu3d = parseJcampText([
    '##$VisuCoreDim=3',
    '##$VisuCoreDimDesc=( 3 )',
    'spatial spatial spatial',
    '##$VisuCoreSize=( 3 )',
    '2 2 3',
    '##$VisuCoreExtent=( 3 )',
    '2.0 2.0 3.0',
    '##$VisuCoreByteOrder=littleEndian',
    '##$VisuCoreWordType=_16BIT_SGN_INT',
    '##$VisuCoreDataSlope=( 2 )',
    '0.25 1.5',
    '##$VisuCoreDataOffs=( 2 )',
    '1.0 -2.0',
    '##$VisuCoreFrameType=MAGNITUDE_IMAGE',
    '##$VisuFGOrderDescDim=1',
    '##$VisuFGOrderDesc=( 1 )',
    '(2, <FG_ECHO>, <>, 0, 0)',
  ].join('\n'));
  const dtype3d = resolveDatatype(visu3d);
  const shape3d = resolveShape(method, visu3d);
  const raw3d = new Uint8Array(24 * 2);
  const dv3d = new DataView(raw3d.buffer);
  for (let i = 0; i < 24; i++) dv3d.setInt16(i * 2, 100, true);
  const dec3d = decode2dseq(raw3d, { dtypeInfo: dtype3d, shapeInfo: shape3d, numSlices: [3] });
  assert.equal(dec3d.perFrameScalingApplied, true);
  assert.equal(dec3d.packs[0].kind, 'float32');
  assert.equal(dec3d.packs[0].data[0], 26); // echo 0: 100 * 0.25 + 1 = 26
  assert.equal(dec3d.packs[0].data[12], 148); // echo 1: 100 * 1.5 - 2 = 148

  // Mismatched slope count throws instead of silently falling back to slope[0]
  assert.throws(
    () => decode2dseq(raw3d, {
      dtypeInfo: { ...dtype3d, slope: [0.25, 1.5, 2.0] },
      shapeInfo: shape3d,
      numSlices: [3],
    }),
    /Per-frame scaling mismatch/,
  );

  // Oversized volume rejected before allocation via byte limit
  assert.throws(
    () => decode2dseq(new Uint8Array(0), {
      dtypeInfo,
      shapeInfo: { ...shapeInfo, shape: [800, 800, 500] },
      numSlices: [500],
      maxBytes: MAX_CONVERT_BYTES,
    }),
    /exceeding the 1024 MiB browser limit/,
  );
});

test('loadBrukerStudy supports lazy Blob.slice ZIPs, folders, PV5.1 versions, 3D SliceThickness, multi-echo, and PII scrubbing', async () => {
  const acqp = [
    '##TITLE=Parameter List',
    '##$ACQ_protocol_name=( 32 )',
    '<T2_RARE_Test>',
    '##$ACQ_scaling_phase=1',
    '##$BF1=400.3',
  ].join('\n');
  const method = [
    '##TITLE=Parameter List',
    '##$Method=<Bruker:RARE>',
    '##$PVM_NSPacks=1',
    '##$PVM_SPackArrNSlices=( 1 )',
    '2',
    '##$PVM_SPackArrSliceDistance=( 1 )',
    '0.5',
    '##$PVM_SPackArrSliceGap=( 1 )',
    '0',
    '##$PVM_SPackArrSliceOrient=( 1 )',
    'axial',
    '##$PVM_ObjOrderScheme=Sequential',
  ].join('\n');
  const visuPars = [
    '##TITLE=Parameter List',
    '##$VisuCreatorVersion=( 16 )',
    '<5.1>',
    '##$VisuCoreDim=2',
    '##$VisuCoreDimDesc=( 2 )',
    'spatial spatial',
    '##$VisuCoreSize=( 2 )',
    '4 4',
    '##$VisuCoreExtent=( 2 )',
    '4.0 4.0',
    '##$VisuCoreFrameThickness=( 1 )',
    '0.5',
    '##$VisuCoreByteOrder=littleEndian',
    '##$VisuCoreWordType=_16BIT_SGN_INT',
    '##$VisuCoreDataSlope=( 2 )',
    '0.5 0.5',
    '##$VisuCoreDataOffs=( 2 )',
    '0 0',
    '##$VisuCoreFrameType=MAGNITUDE_IMAGE',
    '##$VisuFGOrderDescDim=1',
    '##$VisuFGOrderDesc=( 1 )',
    '(2, <FG_SLICE>, <>, 0, 2)',
    '##$VisuCoreOrientation=( 2, 9 )',
    '1 0 0 0 1 0 0 0 1 1 0 0 0 1 0 0 0 1',
    '##$VisuCorePosition=( 2, 3 )',
    '-2 -2 -0.25 -2 -2 0.25',
    '##$VisuSubjectType=Quadruped',
    '##$VisuSubjectPosition=Head_Prone',
    '##$VisuSubjectName=( 32 )',
    '<DO_NOT_LEAK>',
    '##$VisuAcqDate=<2026-01-01T12:00:00>',
    '##$VisuAcqRepetitionTime=( 1 )',
    '2500',
    '##$VisuAcqEchoTime=( 2 )',
    '12 36',
    '##$VisuSeriesTypeId=( 16 )',
    '<ACQ_BRUKER_PVM>',
  ].join('\n');

  const raw2dseq = new Uint8Array(4 * 4 * 2 * 2);
  const dv = new DataView(raw2dseq.buffer);
  for (let i = 0; i < 32; i++) dv.setInt16(i * 2, i * 100, true);

  const enc = new TextEncoder();
  const files = {
    '__MACOSX/._ignore': new Uint8Array([1, 2, 3]),
    '20260101_Rat007/6/acqp': enc.encode(acqp),
    '20260101_Rat007/6/method': enc.encode(method),
    '20260101_Rat007/6/pdata/1/visu_pars': enc.encode(visuPars),
    '20260101_Rat007/6/pdata/1/2dseq': raw2dseq,
  };

  const zipped = zipSync(files);
  // Wrap as a Blob-like object whose .arrayBuffer() throws if anyone tries to read the whole ZIP!
  let sliceCalls = 0;
  const lazyBlob = {
    size: zipped.byteLength,
    slice(start, end) {
      sliceCalls++;
      const sub = zipped.subarray(start, end);
      return {
        arrayBuffer: async () => sub.slice().buffer,
      };
    },
    arrayBuffer() {
      throw new Error('Full ZIP arrayBuffer() must not be called');
    },
  };

  const fromLazyBlob = await loadBrukerStudy(lazyBlob);
  assert.ok(sliceCalls > 0, 'lazy ZIP reader used Blob.slice');
  const fromZip = await loadBrukerStudy(zipped);
  const fromFolder = await loadBrukerStudy(
    Object.entries(files).map(([path, bytes]) => ({ path, bytes })),
  );

  for (const study of [fromLazyBlob, fromZip, fromFolder]) {
    const info = study.summary();
    assert.equal(info.softwareVersion, '5.1');
    assert.equal(info.scans.length, 1);
    assert.equal(info.scans[0].scanId, 6);
    assert.equal(info.scans[0].recos[0].convertible, true);

    // Explicit nonexistent recoId throws instead of falling back silently
    await assert.rejects(() => study.convert({ scanId: 6, recoId: 99 }), /Reconstruction 99 not found/);

    const out = await study.convert({ scanId: 6, recoId: 1 });
    assert.deepEqual(out.shape, [4, 4, 2]);
    assert.equal(out.kind, 'int16');
    assert.equal(out.niftiBytes.byteLength, 352 + 64);

    const outDv = new DataView(out.niftiBytes.buffer, out.niftiBytes.byteOffset);
    assert.equal(outDv.getInt16(70, true), 4); // int16
    assert.equal(outDv.getInt16(254, true), 2); // sform_code
    assert.equal(outDv.getUint8(122), 1); // Sequential
    assert.equal(outDv.getUint8(123), 10); // mm | sec
    assert.equal(outDv.getFloat32(112, true), 0.5); // scl_slope

    // Scrubbed sidecar check
    assert.equal(out.sidecar.Manufacturer, 'Bruker BioSpin');
    assert.equal(out.sidecar.SoftwareVersions, 'ParaVision 5.1');
    assert.equal(out.sidecar.RepetitionTime, 2.5);
    assert.equal(out.sidecar.EchoTime, 0.012);
    assert.deepEqual(out.sidecar.EchoTimes, [0.012, 0.036]);
    assert.equal(out.sidecar.SliceThickness, 0.5);
    assert.equal(out.sidecar.BrukerSeriesType, 'ACQ_BRUKER_PVM');
    assert.equal(Object.hasOwn(out.sidecar, 'ImageType'), false);
    assert.equal(out.sidecar.ScrubbedIdentifiers, true);
    assert.ok(!out.sidecarJson.includes('DO_NOT_LEAK'));
    assert.ok(!out.sidecarJson.includes('Rat007'));
    assert.ok(!out.sidecarJson.includes('2026-01-01'));
  }

  // Over-cap study marked non-convertible during inspection without reading 2dseq
  let read2dseqCalled = false;
  const overCap = await loadBrukerStudy(
    Object.entries(files).map(([path, bytes]) => ({
      path,
      getBytes: () => {
        if (path.endsWith('/2dseq')) read2dseqCalled = true;
        return bytes;
      },
    })),
    { maxBytes: 16 },
  );
  const overSummary = overCap.summary();
  assert.equal(overSummary.scans[0].recos[0].convertible, false);
  assert.equal(overSummary.scans[0].recos[0].exceedsLimit, true);
  await assert.rejects(() => overCap.convert({ scanId: 6, recoId: 1 }), /exceeding the/);
  assert.equal(read2dseqCalled, false, '2dseq must not be read when scan exceeds byte cap');

  // encodeNifti1 rejects unsupported kind
  assert.throws(() => encodeNifti1({ data: new Uint8Array(1), shape: [1], kind: 'int64', affine: [[1,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,0,1]] }));
});
