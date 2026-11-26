import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MANIFEST,
  assetByPath,
  writeNiftiFloat32,
  readNifti,
  readNifti4D,
  reorientVolumeToRAS,
  prepareDwiAdc,
  computeAdcVoxels,
  dagmnetPostprocess,
  runDagmnetDwi,
  runDagmnetPwi,
  computeTtpVolume,
  sliceTimeCorrection,
  computeIcvMl,
  computeLesionVolumes,
  computeMismatch,
  computeAtlasOverlap,
  computeVentricleFeatures,
  computeQfvVectors,
  buildRfFeatureRequests,
  buildQfvCsv,
  buildRadiologicalReportText,
  csvCell,
  treeShapForest,
  evaluateAtlasShap,
  projectSubjectOntoCohort,
  cohortSummaryCsv,
} from '../src/index.js';

test('manifest pins all 82 OpenADS & StrokeView runtime assets on Hugging Face', () => {
  assert.equal(MANIFEST.app, 'openads');
  assert.equal(MANIFEST.assets.length, 82);
  const dwi = assetByPath('models/dagmnet_dwi_ch3.onnx');
  assert.match(dwi.url, /^https:\/\/huggingface\.co\/datasets\/neurodeskorg\/webapps\/resolve\/[0-9a-f]{40}\//);
  assert.equal(dwi.sha256.length, 64);
  assert.ok(assetByPath('cohort/cluster_lobe.json').bytes > 500_000);
  assert.ok(assetByPath('atlases/ArterialAtlas_MNI182.nii.gz').bytes > 100_000);
});

test('NIfTI round-trip and RAS reorientation preserve coordinates and voxels', () => {
  const dims = [4, 3, 2];
  const voxels = Float32Array.from({ length: 24 }, (_, i) => i + 1);
  // LPS affine (negative X and Y diagonals)
  const affine = new Float32Array([
    -1, 0, 0, 3,
    0, -1, 0, 2,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ]);
  const bytes = writeNiftiFloat32({ dims, pixdim: [1, 1, 1], affine, voxels });
  const parsed = readNifti(bytes);
  assert.deepEqual(parsed.dims, dims);
  const ras = reorientVolumeToRAS(parsed);
  assert.equal(ras.affine[0], 1);
  assert.equal(ras.affine[5], 1);
  assert.equal(ras.affine[10], 1);
  // Voxel (0,0,0) in LPS moved to (3,2,0) in RAS
  assert.equal(ras.voxels[3 + 2 * 4], 1);
});

test('prepareDwiAdc computes ADC from DWI + b0 and detects swapped 4D order', () => {
  const b0Vox = new Float32Array([500, 600, 700, 0]);
  const dwiVox = new Float32Array([200, 240, 280, 0]);
  const mk = (voxels) => ({ dims: [2, 2, 1], pixdim: [1, 1, 1], affine: new Float32Array(16), voxels });
  const res = prepareDwiAdc({ dwi: mk(b0Vox), b0: mk(dwiVox), checkSwap: true });
  assert.equal(res.adcWasComputed, true);
  assert.equal(res.orderWasSwapped, true);
  const expected = -Math.log((200 + 1e-10) / (500 + 1e-10)) / 1000;
  assert.ok(Math.abs(res.adc.voxels[0] - expected) < 1e-6);
  assert.equal(res.adc.voxels[3], 0);
});

test('dagmnetPostprocess removes small components and fills interior holes', () => {
  const dims = [10, 10, 10];
  const mask = new Uint8Array(1000);
  // A 4x4x4 cube (64 voxels >= minSize 50) with an interior hole at (4,4,4)
  for (let z = 2; z < 6; z++) {
    for (let y = 2; y < 6; y++) {
      for (let x = 2; x < 6; x++) {
        mask[x + y * 10 + z * 100] = 1;
      }
    }
  }
  mask[4 + 4 * 10 + 4 * 100] = 0;
  // Tiny stray noise voxel far away
  mask[9 + 9 * 10 + 9 * 100] = 1;
  const clean = dagmnetPostprocess(mask, dims, 50);
  assert.equal(clean[4 + 4 * 10 + 4 * 100], 1);
  assert.equal(clean[9 + 9 * 10 + 9 * 100], 0);
});

test('DAGMNet DWI and PWI drivers invoke exactly 16 strided passes with expected tensor shapes', async () => {
  const dims = [16, 16, 16];
  const zeros = new Float32Array(16 * 16 * 16);
  const dwiShapes = [];
  const dwiRes = await runDagmnetDwi({
    dwi: zeros,
    adc: zeros,
    dims,
    runPass: async (_tensor, shape) => {
      dwiShapes.push(shape);
      return new Float32Array(shape[2] * shape[3] * shape[4]);
    },
  });
  assert.equal(dwiShapes.length, 16);
  assert.deepEqual(dwiShapes[0], [1, 3, 96, 112, 48]);
  assert.equal(dwiRes.lesionVoxels, 0);

  const pwiShapes = [];
  const pwiRes = await runDagmnetPwi({
    dwi: zeros,
    adc: zeros,
    ttp: zeros,
    dims,
    runPass: async (_tensor, shape) => {
      pwiShapes.push(shape);
      return new Float32Array(shape[2] * shape[3] * shape[4]).fill(-10);
    },
  });
  assert.equal(pwiShapes.length, 16);
  assert.deepEqual(pwiShapes[0], [1, 4, 48, 112, 96]);
  assert.equal(pwiRes.lesionVoxels, 0);
});

test('computeTtpVolume detects synthetic bolus arrival time on a 4D PWI block', () => {
  const dims = [4, 4, 3, 30];
  const n3 = 4 * 4 * 3;
  const tr = 1.5;
  const pwi = new Float32Array(n3 * 30);
  const mask = new Uint8Array(n3).fill(1);
  // Synthetic bolus drop around frame 15 -> high Gd concentration peak at t = 15 * 1.5 = 22.5s
  for (let t = 0; t < 30; t++) {
    const drop = Math.exp(-0.5 * ((t - 15) / 2.2) ** 2);
    const sig = 1000 * Math.exp(-0.5 * drop);
    for (let v = 0; v < n3; v++) {
      pwi[v + t * n3] = sig;
    }
  }
  const { ttp, dims: outDims } = computeTtpVolume({
    pwi,
    dims,
    pixdim: [2, 2, 5, tr],
    mask,
    sliceTiming: [0, 0.5, 1.0],
  });
  assert.deepEqual(outDims, [4, 4, 3]);
  const centerVal = ttp[2 + 2 * 4 + 1 * 16];
  assert.ok(centerVal > 18 && centerVal < 27, `expected TTP near 22.5s, got ${centerVal}`);
});

test('atlas overlap, QFV, mismatch, and radiological report work end-to-end', () => {
  const dims = [4, 4, 4];
  const pixdim = [2, 2, 2];
  const core = new Float32Array(64);
  const hp = new Float32Array(64);
  // 8 voxels in left hemisphere (x < 2) for core (0.064 mL), 24 voxels for hp (0.192 mL)
  for (let z = 0; z < 2; z++) {
    for (let y = 0; y < 2; y++) {
      for (let x = 0; x < 2; x++) core[x + y * 4 + z * 16] = 1;
    }
  }
  for (let z = 0; z < 3; z++) {
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 2; x++) hp[x + y * 4 + z * 16] = 1;
    }
  }
  const volumes = computeLesionVolumes(core, dims, pixdim);
  assert.equal(volumes.totalVoxels, 8);
  assert.ok(Math.abs(volumes.leftMl - 0.064) < 1e-6);
  assert.equal(volumes.rightMl, 0);

  const mismatch = computeMismatch(core, hp, dims, pixdim);
  assert.ok(Math.abs(mismatch.mismatchRatio - 3) < 1e-6);

  const atlas = new Float32Array(64).fill(1);
  const lookup = { regions: ['MCAFL'], volumeVoxels: [64] };
  const overlap = computeAtlasOverlap(volumes.binaryMask, dims, atlas, dims, lookup);
  assert.equal(overlap[0].overlapVoxels, 8);

  const qfv = computeQfvVectors({ vascular: overlap }, volumes.totalMl);
  assert.ok(qfv.vascular.byRegion.MCA > 0);
  assert.match(buildQfvCsv('sub-test', qfv.vascular), /^subject_id,volml,ACA,MCA,/);

  const rfReqs = buildRfFeatureRequests({ vascular: overlap, lobe: [], aspects: [] }, volumes.totalMl, pixdim);
  assert.equal(rfReqs.vascular.length, 7);
  assert.equal(rfReqs.lobe.length, 11);
  assert.equal(rfReqs.aspects.length, 10);

  const report = buildRadiologicalReportText({
    subjectId: 'sub-test',
    volumes,
    icvMl: 1200,
    interpretation: {
      vascular: [{ region: 'MCA', predict: 'AFFECTED', probability: 0.92, volumeMl: 10 }],
      lobe: [{ region: 'insula', predict: 'AFFECTED', probability: 0.85, volumeMl: 4 }],
      aspects: [
        { region: 'insula', predict: 'AFFECTED', probability: 0.85, volumeMl: 4 },
        { region: 'M1', predict: 'NORMAL', probability: 0.1, volumeMl: 0 },
      ],
    },
    hydrocephalus: { predict: 'NORMAL', probability: 0.05 },
    mismatch,
  });
  assert.equal(report.aspectsScore, 9);
  assert.match(report.text, /middle cerebral artery/);
  assert.match(report.text, /Predicted MCA-ASPECTS: 9 \/ 10/);
  assert.match(report.text, /Core-penumbra mismatch/);
});

test('TreeSHAP satisfies exact efficiency sum(phi) + base === f(x) on a 1-tree forest', () => {
  // Single stump: root splits on feature 0 <= 0.5 -> left leaf (val 0.2, cover 60), right leaf (val 0.8, cover 40)
  const forest = {
    nTrees: 1,
    offsets: new Int32Array([0, 3]),
    threshold: new Float32Array([0.5, 0, 0]),
    right: new Int16Array([2, -1, -1]),
    feature: new Int8Array([0, -2, -2]),
    cover: new Float64Array([100, 60, 40]),
    value1: new Float64Array([0.44, 0.2, 0.8]),
    value0: new Float64Array([0.56, 0.8, 0.2]),
    maxDepth: 1,
  };
  const { values, base } = treeShapForest(forest, new Float32Array([0.9, 0.1]), 1);
  assert.ok(Math.abs(base - 0.44) < 1e-6);
  assert.ok(Math.abs(base + values[0] + values[1] - 0.8) < 1e-6);
  assert.equal(values[1], 0);
});

test('StrokeView UMAP cohort projection finds nearest neighbors and summarizes phenotypes', () => {
  const refData = {
    title: 'Lobe Model UMAP',
    features: ['QFV_frontal', 'QFV_insula'],
    scaler_mean: [0, 0],
    scaler_scale: [1, 1],
    points: [
      { x: 1, y: 1, ColorLabel: 'frontal', scaled_features: [0.8, 0.1], phenotype: { Age: 70, NIHSS: 8, '90days-mRS': 2, Sex: 'F', Side: 'left' } },
      { x: 1.2, y: 0.9, ColorLabel: 'frontal', scaled_features: [0.7, 0.15], phenotype: { Age: 60, NIHSS: 6, '90days-mRS': 1, Sex: 'M', Side: 'left' } },
      { x: -5, y: -5, ColorLabel: 'insula', scaled_features: [0.0, 0.9], phenotype: { Age: 80, NIHSS: 16, '90days-mRS': 5, Sex: 'F', Side: 'right' } },
    ],
  };
  const proj = projectSubjectOntoCohort({
    qfvByRegion: { frontal: 0.78, insula: 0.12 },
    refData,
    kNeighbors: 2,
    kProject: 2,
  });
  assert.equal(proj.dominantLabel, 'frontal');
  assert.equal(proj.neighbors.length, 2);
  assert.ok(proj.position.x > 0.5);
  const ageStat = proj.summary.continuous.find((c) => c.key === 'Age');
  assert.equal(ageStat.mean, 65);
  assert.match(cohortSummaryCsv(proj.summary), /Age \(years\),65\.0 \(5\.0\),2/);
});

test('NIfTI-1 qform-only scans preserve quaternion, qfac, origin and disable scaling when scl_slope is 0', () => {
  const buf = new ArrayBuffer(352 + 8 * 4);
  const view = new DataView(buf);
  view.setInt32(0, 348, true);
  view.setInt16(40, 3, true);
  view.setInt16(42, 2, true);
  view.setInt16(44, 2, true);
  view.setInt16(46, 2, true);
  view.setInt16(70, 16, true);
  view.setInt16(72, 32, true);
  view.setFloat32(76, -1, true); // qfac = -1 -> negative Z direction
  view.setFloat32(80, 2, true);
  view.setFloat32(84, 2, true);
  view.setFloat32(88, 3, true);
  view.setFloat32(108, 352, true);
  view.setFloat32(112, 0, true); // scl_slope = 0 disables scaling
  view.setFloat32(116, 10, true); // scl_inter = 10 must be ignored when slope = 0
  view.setInt8(123, 2); // mm
  view.setInt16(252, 1, true); // qform_code = 1
  view.setInt16(254, 0, true); // sform_code = 0 (qform-only)
  view.setFloat32(256, 0, true);
  view.setFloat32(260, 0, true);
  view.setFloat32(264, 0, true);
  view.setFloat32(268, 42, true); // qoffset_x = 42 mm
  view.setFloat32(272, -10, true);
  view.setFloat32(276, 5, true);
  view.setFloat32(352, 600, true);
  new Uint8Array(buf, 344, 4).set([0x6e, 0x2b, 0x31, 0x00]);

  const vol = readNifti(new Uint8Array(buf));
  assert.equal(vol.voxels[0], 600);
  assert.equal(vol.affine[3], 42);
  assert.equal(vol.affine[7], -10);
  assert.equal(vol.affine[10], -3);

  // Round-trip write preserves matching qform and sform
  const written = writeNiftiFloat32(vol);
  const wv = new DataView(written.buffer, written.byteOffset, written.byteLength);
  assert.equal(wv.getInt16(252, true), 1);
  assert.equal(wv.getFloat32(76, true), -1);
  assert.equal(wv.getFloat32(268, true), 42);
  // Force qform-only read on written bytes -> must match sform
  wv.setInt16(254, 0, true);
  const rereadQform = readNifti(written);
  for (let i = 0; i < 16; i++) {
    assert.ok(Math.abs(rereadQform.affine[i] - vol.affine[i]) < 1e-4, `affine[${i}] mismatch`);
  }

  // Sheared sform must unset qform_code so qform never contradicts sform
  const sheared = writeNiftiFloat32({
    dims: [2, 2, 2],
    pixdim: [1, 1, 1],
    voxels: new Float32Array(8),
    affine: new Float32Array([1, 0.5, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
  });
  const sv = new DataView(sheared.buffer, sheared.byteOffset, sheared.byteLength);
  assert.equal(sv.getInt16(252, true), 0);
  assert.equal(sv.getInt16(254, true), 1);
});

test('voxelwise pairings reject mismatched physical affines and short buffers', () => {
  const idAffine = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const shiftedAffine = new Float32Array([1, 0, 0, 15, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const dims = [2, 2, 2];

  assert.throws(
    () =>
      computeAtlasOverlap(new Uint8Array(8), dims, new Float32Array(8), dims, { regions: ['R1'], volumeVoxels: [8] }, {
        maskAffine: idAffine,
        atlasAffine: shiftedAffine,
      }),
    /Physical affine mismatch/,
  );
  assert.throws(
    () =>
      computeVentricleFeatures(
        new Float32Array(8),
        new Uint8Array(8),
        dims,
        new Float32Array(8),
        dims,
        { regions: [], lvorVolumeVoxels: new Array(10).fill(1), lvirVolumeVoxels: new Array(10).fill(1) },
        0.549,
        { adcAffine: idAffine, brainMaskAffine: shiftedAffine, ventAffine: idAffine },
      ),
    /Physical affine mismatch/,
  );
  assert.throws(
    () =>
      prepareDwiAdc({
        dwi: { dims, pixdim: [1, 1, 1], affine: idAffine, voxels: new Float32Array(8).fill(100) },
        b0: { dims, pixdim: [1, 1, 1], affine: shiftedAffine, voxels: new Float32Array(8).fill(500) },
      }),
    /Physical affine mismatch/,
  );
  assert.throws(() => computeAdcVoxels(new Float32Array(8), new Float32Array(4)), /identical length/);
});

test('DAGMNet PWI feeds strokeMask into channel 4 and DWI feeds explicit probIs into channel 3', async () => {
  const dims = [4, 4, 4];
  const n = 64;
  const dwi = new Float32Array(n).fill(10);
  const adc = new Float32Array(n).fill(2);
  const ttp = new Float32Array(n).fill(5);
  const strokeMask = new Float32Array(n);
  strokeMask[0] = 1;
  strokeMask[1] = 1;

  let ch4NonZero = false;
  await runDagmnetPwi({
    dwi,
    adc,
    ttp,
    strokeMask,
    dims,
    runPass: async (tensor, shape) => {
      const cSize = shape[2] * shape[3] * shape[4];
      for (let i = 3 * cSize; i < 4 * cSize; i++) {
        if (Math.abs(tensor[i]) > 1e-6) ch4NonZero = true;
      }
      return new Float32Array(cSize).fill(-10);
    },
  });
  assert.equal(ch4NonZero, true, 'expected non-zero normalized stroke mask in PWI channel 4');

  const probIs = new Float32Array(n);
  probIs[0] = 0.75;
  let ch3NonZero = false;
  await runDagmnetDwi({
    dwi,
    adc,
    dims,
    probIs,
    runPass: async (tensor, shape) => {
      const cSize = shape[2] * shape[3] * shape[4];
      for (let i = 2 * cSize; i < 3 * cSize; i++) {
        if (Math.abs(tensor[i]) > 1e-6) ch3NonZero = true;
      }
      return new Float32Array(cSize);
    },
  });
  assert.equal(ch3NonZero, true, 'expected non-zero Prob_IS prior in DWI channel 3');
});

test('TreeSHAP aspectpc resolves case-insensitive features and matches base + sum(SHAP) === probability', () => {
  const manifest = {
    atlas: 'ASPECTSPC',
    features: ['volml', 'PCA', 'Thalamus', 'cerebellum', 'pons', 'midbrain'],
    models: [
      {
        roi: 'Cerebellum',
        kind: 'forest',
        featureCols: [
          'volml', 'PCA', 'Thalamus', 'Cerebellum', 'Pons', 'Midbrain',
          'logvol', 'sqrtvol', 'PCA_x_vol', 'Thalamus_x_vol', 'Cerebellum_x_vol', 'Pons_x_vol', 'Midbrain_x_vol',
        ],
        scalerMean: new Array(13).fill(0),
        scalerScale: new Array(13).fill(1),
      },
    ],
  };
  // Stump splits on feature 3 (Cerebellum) <= 0.25 -> left 0.1, right 0.9
  const forest = {
    nTrees: 1,
    offsets: new Int32Array([0, 3]),
    threshold: new Float32Array([0.25, 0, 0]),
    right: new Int16Array([2, -1, -1]),
    feature: new Int8Array([3, -2, -2]),
    cover: new Float64Array([100, 50, 50]),
    value1: new Float64Array([0.5, 0.1, 0.9]),
    value0: new Float64Array([0.5, 0.9, 0.1]),
    maxDepth: 1,
  };
  const qfvMap = new Map([
    ['volml', 1.2],
    ['PCA', 0.1],
    ['Thalamus', 0.05],
    ['cerebellum', 0.42],
    ['pons', 0.15],
    ['midbrain', 0.08],
  ]);
  const [res] = evaluateAtlasShap({
    atlasKey: 'aspectpc',
    manifest,
    forestsByRoi: new Map([['Cerebellum', forest]]),
    qfvMap,
  });
  const cerebAttr = res.attributions.find((a) => a.feature === 'Cerebellum');
  const cerebInter = res.attributions.find((a) => a.feature === 'Cerebellum_x_vol');
  assert.ok(Math.abs(cerebAttr.value - 0.42) < 1e-4);
  assert.ok(Math.abs(cerebInter.value) > 0, 'expected non-zero Cerebellum_x_vol interaction');
  const sumShap = res.attributions.reduce((acc, a) => acc + a.attribution, 0);
  assert.ok(Math.abs(res.baseValue + sumShap - res.probability) < 1e-6);
  assert.ok(Math.abs(res.probability - 0.9) < 1e-6);
});

test('PWI validation rejects 3D or short series and respects millisecond xyzt_units', () => {
  assert.throws(
    () => computeTtpVolume({ pwi: new Float32Array(8), dims: [2, 2, 2, 1], pixdim: [1, 1, 1, 1.5], mask: new Uint8Array(8).fill(1) }),
    /at least 10 time frames/,
  );
  // 4D header with xyzt_units = 2 (mm) | 16 (ms) = 18 and pixdim[4] = 1700 ms -> 1.7 s
  const buf = new ArrayBuffer(352 + 2 * 4);
  const view = new DataView(buf);
  view.setInt32(0, 348, true);
  view.setInt16(40, 4, true);
  view.setInt16(42, 1, true);
  view.setInt16(44, 1, true);
  view.setInt16(46, 1, true);
  view.setInt16(48, 2, true);
  view.setInt16(70, 16, true);
  view.setInt16(72, 32, true);
  view.setFloat32(80, 1, true);
  view.setFloat32(84, 1, true);
  view.setFloat32(88, 1, true);
  view.setFloat32(92, 1700, true);
  view.setFloat32(108, 352, true);
  view.setInt8(123, 18); // mm + ms
  new Uint8Array(buf, 344, 4).set([0x6e, 0x2b, 0x31, 0x00]);
  const vol4d = readNifti4D(new Uint8Array(buf));
  assert.ok(Math.abs(vol4d.pixdim[3] - 1.7) < 1e-5);
});

test('ICV returns null without a brain mask and CSV cells neutralize spreadsheet formulas', () => {
  assert.equal(computeIcvMl(null, [2, 2, 2], [1, 1, 1]), null);
  assert.equal(computeIcvMl(new Uint8Array(8), [2, 2, 2], [1, 1, 1]), null);
  assert.equal(csvCell('=SUM(A1:A2)'), "'=SUM(A1:A2)");
  assert.equal(csvCell('+cmd'), "'+cmd");
  assert.equal(csvCell("a\rb"), '"a\rb"');
});

test('readNifti derives voxel spacing from affine, rejects oversized buffers, and honors BIDS SliceEncodingDirection', () => {
  // Header claims pixdim[1]=2 mm while sform has 1 mm spacing -> pixdim must match sform (1 mm)
  const buf = new ArrayBuffer(352 + 8 * 4);
  const view = new DataView(buf);
  view.setInt32(0, 348, true);
  view.setInt16(40, 3, true);
  view.setInt16(42, 2, true);
  view.setInt16(44, 2, true);
  view.setInt16(46, 2, true);
  view.setInt16(70, 16, true);
  view.setInt16(72, 32, true);
  view.setFloat32(80, 2, true);
  view.setFloat32(84, 1, true);
  view.setFloat32(88, 1, true);
  view.setFloat32(108, 352, true);
  view.setFloat32(112, 1, true);
  view.setInt16(254, 1, true);
  view.setFloat32(280, 1, true);
  view.setFloat32(300, 1, true);
  view.setFloat32(320, 1, true);
  new Uint8Array(buf, 344, 4).set([0x6e, 0x2b, 0x31, 0x00]);
  const vol = readNifti(new Uint8Array(buf));
  assert.equal(vol.pixdim[0], 1);

  // Oversized buffer rejected by computeAtlasOverlap
  assert.throws(
    () => computeAtlasOverlap(new Uint8Array(8), [2, 2, 2], new Float32Array(12), [2, 2, 2], { regions: ['R1'], volumeVoxels: [8] }),
    /does not match its grid/,
  );

  // SliceEncodingDirection k- reverses slice timing order; j applies timing along axis 1
  const dims = [2, 3, 2, 4];
  const n3 = 12;
  const pwi = new Float32Array(n3 * 4);
  for (let t = 0; t < 4; t++) {
    for (let z = 0; z < 2; z++) {
      for (let y = 0; y < 3; y++) {
        for (let x = 0; x < 2; x++) {
          // Linear ramp in time: signal(t) = 10 + 2 * (t_sample)
          pwi[x + y * 2 + z * 6 + t * n3] = 10 + 2 * t;
        }
      }
    }
  }
  const kPos = sliceTimeCorrection(pwi, dims, 2.0, [0.0, 1.0], { sliceEncodingDirection: 'k' });
  const kNeg = sliceTimeCorrection(pwi, dims, 2.0, [0.0, 1.0], { sliceEncodingDirection: 'k-' });
  // Under k, z=0 has offset 0 (unchanged); under k-, z=1 has offset 0 and z=0 has offset 1.0
  assert.ok(Math.abs(kPos.data[0 + n3] - 12) < 1e-4);
  assert.ok(Math.abs(kNeg.data[6 + n3] - 12) < 1e-4);
  assert.ok(Math.abs(kNeg.data[0 + n3] - 11) < 1e-4);

  const jDir = sliceTimeCorrection(pwi, dims, 2.0, [0.0, 0.5, 1.0], { sliceEncodingDirection: 'j' });
  assert.ok(Math.abs(jDir.data[0 + n3] - 12) < 1e-4);
  assert.ok(Math.abs(jDir.data[4 + n3] - 11) < 1e-4);
});
