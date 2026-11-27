// Offline analytical phantom, topology, diameter, ROI density, CLI, and
// real VesselBoost Lausanne TOF crop regression tests for @neurodesk/vesselcharter.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { writeNiftiVolume } from '@neurodesk/webapp-components/file-io/nifti-volume';
import {
  TURBO_COLORMAP,
  buildOutputArtifacts,
  buildVesselTreeScalars,
  characterizeVesselMask,
  characterizeVesselNifti,
  computeDiameterDisplayRange,
  euclideanDistanceTransform3D,
  inspectAffine,
  isEulerInvariant,
  isSimplePoint,
  pointToBackgroundBoxDistance,
  readBinaryMaskNifti,
  sampleColormapRgba,
} from '../src/index.js';
import { characterize, checkInstallation } from '../src/node.js';
import {
  cylinderPhantom,
  helixPhantom,
  packPhantomNifti,
  sphereRoiMask,
  thinTubePhantom,
  torusLoopPhantom,
  yBifurcationPhantom,
} from '../src/phantom.js';

const CLI_PATH = fileURLToPath(new URL('../bin/vesselcharter.js', import.meta.url));
const LAUSANNE_FIXTURE = fileURLToPath(
  new URL('../../../apps/vesselboost/test/fixtures/upstream-reference/lausanne-tof-crop-192x192x64_vesselboost-manual_0429.nii.gz', import.meta.url),
);

test('anisotropic 3D EDT matches exhaustive brute-force distance to 1e-12 mm', () => {
  const dims = [11, 10, 9];
  const spacing = [0.46875, 0.46875, 0.7];
  const [nx, ny, nz] = dims;
  const mask = new Uint8Array(nx * ny * nz);
  for (let z = 2; z <= 6; z += 1) {
    for (let y = 2; y <= 7; y += 1) {
      for (let x = 3; x <= 7; x += 1) {
        if ((x - 5) ** 2 + (y - 4.5) ** 2 <= 5.5) {
          mask[z * nx * ny + y * nx + x] = 1;
        }
      }
    }
  }
  const edt = euclideanDistanceTransform3D(mask, dims, spacing);
  let maxErr = 0;
  for (let z = 0; z < nz; z += 1) {
    for (let y = 0; y < ny; y += 1) {
      for (let x = 0; x < nx; x += 1) {
        const idx = z * nx * ny + y * nx + x;
        if (!mask[idx]) {
          assert.equal(edt[idx], 0);
          continue;
        }
        let bestSq = Infinity;
        for (let qz = 0; qz < nz; qz += 1) {
          for (let qy = 0; qy < ny; qy += 1) {
            for (let qx = 0; qx < nx; qx += 1) {
              if (mask[qz * nx * ny + qy * nx + qx]) continue;
              const dSq =
                ((x - qx) * spacing[0]) ** 2 +
                ((y - qy) * spacing[1]) ** 2 +
                ((z - qz) * spacing[2]) ** 2;
              if (dSq < bestSq) bestSq = dSq;
            }
          }
        }
        maxErr = Math.max(maxErr, Math.abs(edt[idx] - Math.sqrt(bestSq)));
      }
    }
  }
  assert.ok(maxErr < 1e-12, `Expected exact EDT, got maxErr=${maxErr}`);
});

test('point-to-background-box distance matches exhaustive box check and handles 1-vox and 2-vox tubes', () => {
  // 1-voxel tube at Lausanne anisotropic spacing: exact diameter = 0.46875 mm (not 0.9375 mm!)
  const tube1 = thinTubePhantom({ widthVox: 1, lengthVox: 24, spacing: [0.46875, 0.46875, 0.7] });
  const res1 = characterizeVesselMask({
    mask: tube1.mask,
    dims: tube1.dims,
    spatial: tube1.spatial,
    parameters: { minSpurLengthMm: 0, smoothIterations: 0, fillHoles: false },
  });
  assert.equal(res1.summary.network.segmentCount, 1);
  assert.ok(
    Math.abs(res1.segments[0].medianDiameterMm - 0.46875) < 1e-6,
    `1-voxel tube diameter expected 0.46875 mm, got ${res1.segments[0].medianDiameterMm}`,
  );
  assert.equal(res1.segments[0].resolutionLimited, true, '1-voxel tube must be flagged resolution_limited');

  // 2-voxel tube: subvoxel centering recovers exact 2 * 0.46875 = 0.9375 mm!
  const tube2 = thinTubePhantom({ widthVox: 2, lengthVox: 24, spacing: [0.46875, 0.46875, 0.7] });
  const res2 = characterizeVesselMask({
    mask: tube2.mask,
    dims: tube2.dims,
    spatial: tube2.spatial,
    parameters: { minSpurLengthMm: 0, smoothIterations: 0, fillHoles: false },
  });
  assert.equal(res2.summary.network.segmentCount, 1);
  assert.ok(
    Math.abs(res2.segments[0].medianDiameterMm - 0.9375) < 1e-6,
    `2-voxel tube diameter expected 0.9375 mm, got ${res2.segments[0].medianDiameterMm}`,
  );
  assert.equal(res2.segments[0].resolutionLimited, true, '2-voxel tube (< 2*0.7=1.4mm) is flagged resolution_limited');

  // Direct point-to-box sanity check on a single voxel at center.
  const single = new Uint8Array(27);
  single[13] = 1;
  const r = pointToBackgroundBoxDistance(single, [3, 3, 3], [0.5, 0.5, 0.8], 1, 1, 1);
  assert.ok(Math.abs(r.radiusMm - 0.25) < 1e-12);
});

test('Lee94 Euler invariance + simple point agrees with exact Bertrand-Malandain simplicity', () => {
  const N6 = [4, 10, 12, 14, 16, 22];
  const isN18 = new Uint8Array(27);
  const adj6 = Array.from({ length: 27 }, () => []);
  for (let i = 0; i < 27; i += 1) {
    if (i === 13) continue;
    const z = Math.floor(i / 9) - 1;
    const y = Math.floor((i % 9) / 3) - 1;
    const x = (i % 3) - 1;
    if (Math.abs(x) + Math.abs(y) + Math.abs(z) <= 2) isN18[i] = 1;
  }
  for (let a = 0; a < 27; a += 1) {
    if (!isN18[a]) continue;
    const az = Math.floor(a / 9) - 1;
    const ay = Math.floor((a % 9) / 3) - 1;
    const ax = (a % 3) - 1;
    for (let b = 0; b < 27; b += 1) {
      if (!isN18[b] || a === b) continue;
      const bz = Math.floor(b / 9) - 1;
      const by = Math.floor((b % 9) / 3) - 1;
      const bx = (b % 3) - 1;
      if (Math.abs(ax - bx) + Math.abs(ay - by) + Math.abs(az - bz) === 1) adj6[a].push(b);
    }
  }
  const bgSimple = (n) => {
    const seen = new Uint8Array(27);
    let comps = 0;
    for (const s of N6) {
      if (n[s] !== 0 || seen[s]) continue;
      comps += 1;
      if (comps > 1) return false;
      const q = [s];
      seen[s] = 1;
      for (let h = 0; h < q.length; h += 1) {
        for (const nb of adj6[q[h]]) {
          if (n[nb] === 0 && !seen[nb]) {
            seen[nb] = 1;
            q.push(nb);
          }
        }
      }
    }
    return comps === 1;
  };

  // Deterministic LCG for reproducible 2,000-configuration check.
  let seed = 42;
  const nextRand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  const n = new Uint8Array(27);
  for (let t = 0; t < 2000; t += 1) {
    for (let i = 0; i < 27; i += 1) n[i] = i === 13 ? 1 : nextRand() < 0.45 ? 1 : 0;
    const lee = isSimplePoint(n) && isEulerInvariant(n);
    const bm = isSimplePoint(n) && bgSimple(n);
    assert.equal(lee, bm, `Mismatch at deterministic sample ${t}`);
  }
});

test('analytical straight and oblique anisotropic cylinders recover length, diameter and tortuosity', () => {
  // Anisotropic oblique cylinder (45 deg in XY, tilted in Z).
  const cyl = cylinderPhantom({
    dims: [56, 56, 44],
    spacing: [0.46875, 0.46875, 0.7],
    radiusMm: 2.0,
    startMm: [6, 6, 6],
    endMm: [20, 20, 22],
  });
  const out = characterizeVesselMask({
    mask: cyl.mask,
    dims: cyl.dims,
    spatial: cyl.spatial,
    parameters: { minSpurLengthMm: 1.0, smoothIterations: 6 },
  });
  const net = out.summary.network;
  assert.equal(net.segmentCount, 1);
  assert.equal(net.junctionCount, 0);
  assert.equal(net.endpointCount, 2);
  assert.equal(net.cycleRankBetti1, 0);

  const seg = out.segments[0];
  assert.ok(
    Math.abs(seg.medianDiameterMm - 4.0) <= 0.6,
    `Oblique anisotropic cylinder diameter expected ~4.0 mm, got ${seg.medianDiameterMm}`,
  );
  assert.ok(
    Math.abs(seg.equivDiameterMm - 4.0) <= 0.6,
    `Oblique anisotropic cylinder D_eq expected ~4.0 mm, got ${seg.equivDiameterMm}`,
  );
  assert.ok(
    Math.abs(seg.lengthMm - cyl.groundTruth.lengthMm) / cyl.groundTruth.lengthMm < 0.08,
    `Length expected ~${cyl.groundTruth.lengthMm.toFixed(2)}, got ${seg.lengthMm.toFixed(2)}`,
  );
  assert.ok(seg.dmTortuosity >= 1.0 && seg.dmTortuosity < 1.05, `Straight cylinder DM expected ~1.0, got ${seg.dmTortuosity}`);
  assert.equal(seg.resolutionLimited, false);
});

test('analytical Y-bifurcations recover topology, daughter angles and caliber ratios', () => {
  for (const targetAngle of [60, 90, 120]) {
    const bif = yBifurcationPhantom({
      daughterAngleDeg: targetAngle,
      parentRadiusMm: 2.0,
      daughter1RadiusMm: 1.4,
      daughter2RadiusMm: 1.4,
    });
    const out = characterizeVesselMask({
      mask: bif.mask,
      dims: bif.dims,
      spatial: bif.spatial,
      parameters: { minSpurLengthMm: 1.5, smoothIterations: 6 },
    });
    const net = out.summary.network;
    assert.equal(net.segmentCount, 3, `${targetAngle} deg: expected 3 segments`);
    assert.equal(net.junctionCount, 1, `${targetAngle} deg: expected 1 junction`);
    assert.equal(net.bifurcationCount, 1, `${targetAngle} deg: expected 1 bifurcation`);
    assert.equal(net.endpointCount, 3, `${targetAngle} deg: expected 3 endpoints`);
    assert.equal(net.cycleRankBetti1, 0);

    const junc = out.junctions[0];
    assert.equal(junc.parentInferredFromCaliber, true);
    assert.ok(
      Math.abs(junc.daughterAngleDeg - targetAngle) < 8,
      `${targetAngle} deg Y-bifurcation recovered ${junc.daughterAngleDeg.toFixed(2)} deg`,
    );
    assert.ok(
      Math.abs(net.meanBifurcationAngleDeg - targetAngle) < 8,
      `${targetAngle} deg network meanBifurcationAngleDeg expected ~${targetAngle}, got ${net.meanBifurcationAngleDeg.toFixed(2)}`,
    );
    assert.ok(junc.murrayRatioCubed > 0.4 && junc.murrayRatioCubed < 1.2);
  }
});

test('torus phantom preserves closed Circle-of-Willis loop (Betti-1 = 1)', () => {
  const torus = torusLoopPhantom({ majorRadiusMm: 8.0, minorRadiusMm: 1.5 });
  const out = characterizeVesselMask({
    mask: torus.mask,
    dims: torus.dims,
    spatial: torus.spatial,
    parameters: { minSpurLengthMm: 1.0, smoothIterations: 6 },
  });
  const net = out.summary.network;
  assert.equal(net.cycleRankBetti1, 1);
  assert.equal(net.segmentCount, 1);
  assert.equal(net.junctionCount, 0);
  assert.equal(net.endpointCount, 0);
  assert.equal(out.segments[0].isClosedLoop, true);
  assert.equal(out.segments[0].dmTortuosity, null);
  assert.ok(
    Math.abs(out.segments[0].lengthMm - torus.groundTruth.perimeterMm) / torus.groundTruth.perimeterMm < 0.06,
    `Torus perimeter expected ${torus.groundTruth.perimeterMm.toFixed(2)}, got ${out.segments[0].lengthMm.toFixed(2)}`,
  );
});

test('3D helix phantom recovers arc length, DM tortuosity and positive SOAM', () => {
  const helix = helixPhantom();
  const out = characterizeVesselMask({
    mask: helix.mask,
    dims: helix.dims,
    spatial: helix.spatial,
    parameters: { minSpurLengthMm: 1.5, smoothIterations: 6 },
  });
  assert.equal(out.summary.network.segmentCount, 1);
  const seg = out.segments[0];
  const lenErr = Math.abs(seg.lengthMm - helix.groundTruth.lengthMm) / helix.groundTruth.lengthMm;
  const dmErr = Math.abs(seg.dmTortuosity - helix.groundTruth.dmTortuosity) / helix.groundTruth.dmTortuosity;
  assert.ok(lenErr < 0.08, `Helix length err ${(lenErr * 100).toFixed(1)}%`);
  assert.ok(dmErr < 0.08, `Helix DM err ${(dmErr * 100).toFixed(1)}% (got ${seg.dmTortuosity.toFixed(3)} vs ${helix.groundTruth.dmTortuosity.toFixed(3)})`);
  assert.ok(seg.soamRadPerMm !== null && seg.soamRadPerMm > 0.1, `Helix SOAM expected > 0.1, got ${seg.soamRadPerMm}`);
});

test('interior hole filling removes hollow cavities before skeletonisation', () => {
  const cyl = cylinderPhantom({ dims: [32, 32, 32], spacing: [0.5, 0.5, 0.5], radiusMm: 2.5, startMm: [8, 8, 4], endMm: [8, 8, 12] });
  // Punch a 1-voxel hollow cavity right at the center of the cylinder.
  const centerIdx = 16 * 32 * 32 + 16 * 32 + 16;
  assert.equal(cyl.mask[centerIdx], 1);
  cyl.mask[centerIdx] = 0;

  const filled = characterizeVesselMask({
    mask: cyl.mask,
    dims: cyl.dims,
    spatial: cyl.spatial,
    parameters: { fillHoles: true, minSpurLengthMm: 1.0 },
  });
  assert.equal(filled.summary.input.holesFilledVoxels, 1);
  assert.equal(filled.summary.network.cycleRankBetti1, 0);
  assert.equal(filled.summary.network.segmentCount, 1);
});

test('optional brain/ROI mask computes accurate vessel volume fraction and length density', () => {
  const cyl = cylinderPhantom({
    dims: [48, 48, 48],
    spacing: [0.5, 0.5, 0.5],
    radiusMm: 1.5,
    startMm: [12, 12, 6],
    endMm: [12, 12, 18],
  });
  const roi = sphereRoiMask(cyl.dims, cyl.spatial.spacing, 8.0);
  const out = characterizeVesselMask({
    mask: cyl.mask,
    dims: cyl.dims,
    spatial: cyl.spatial,
    brainMask: roi.mask,
    parameters: { minSpurLengthMm: 0.5 },
  });
  const r = out.summary.roi;
  assert.ok(r !== null);
  assert.equal(r.roiVoxelCount, roi.voxelCount);
  assert.ok(r.roiVolumeMm3 > 2000 && r.roiVolumeMm3 < 2300);
  assert.ok(r.vesselVolumeFraction > 0.03 && r.vesselVolumeFraction < 0.06);
  assert.ok(r.roiTotalLengthMm > 10 && r.roiTotalLengthMm <= 13);
  assert.ok(r.vesselLengthDensityMmPerCm3 > 4.5 && r.vesselLengthDensityMmPerCm3 < 7.0);
});

test('affine validation rejects singular or materially sheared matrices', () => {
  assert.throws(
    () =>
      inspectAffine(
        [
          [1, 0.3, 0, 0],
          [0, 1, 0, 0],
          [0, 0, 1, 0],
          [0, 0, 0, 1],
        ],
        2,
      ),
    /shear/i,
  );
  assert.throws(
    () =>
      inspectAffine(
        [
          [1, 0, 0, 0],
          [0, 0, 0, 0],
          [0, 0, 1, 0],
          [0, 0, 0, 1],
        ],
        2,
      ),
    /spacing|singular/i,
  );
});

test('Lausanne TOF VesselBoost upstream fixture runs deterministically and produces valid outputs', async () => {
  const bytes = await readFile(LAUSANNE_FIXTURE);
  const { result, artifacts } = await characterizeVesselNifti({
    vesselBytes: bytes,
    baseName: 'lausanne-tof-crop-192x192x64_vesselboost-manual_0429.nii.gz',
  });
  const inp = result.summary.input;
  const net = result.summary.network;

  assert.deepEqual(inp.dimensions, [192, 192, 64]);
  assert.equal(inp.inputVesselVoxels, 33894);
  assert.equal(inp.holesFilledVoxels, 2);
  assert.equal(inp.touchesFovVoxels, 1169);
  assert.equal(inp.assumedUnitsMm, true);
  assert.equal(inp.inputComponentCount, 35);
  assert.ok(Math.abs(inp.inputVesselVolumeMm3 - 5213.19) < 0.5);

  assert.ok(net.segmentCount > 80 && net.segmentCount < 220);
  assert.ok(net.junctionCount > 25 && net.junctionCount < 100);
  assert.ok(net.totalLengthMm > 800 && net.totalLengthMm < 1200);
  assert.ok(net.medianDiameterMm > 0.45 && net.medianDiameterMm < 2.0);
  assert.ok(net.fovEndpointCount > 0, 'Crop fixture must detect FOV-truncated vessel endpoints');

  // Verify all expected serialized artifacts exist and are nonempty.
  assert.ok(artifacts.summary.bytes.byteLength > 200);
  assert.ok(artifacts.graph.bytes.byteLength > 1000);
  assert.ok(artifacts.segments.bytes.byteLength > 1000);
  assert.ok(artifacts.junctions.bytes.byteLength > 500);
  assert.ok(artifacts.diameterBins.bytes.byteLength > 100);
  assert.ok(artifacts.diameterMap.bytes.byteLength > 1000);
  assert.ok(artifacts.skeletonLabels.bytes.byteLength > 1000);
  assert.ok(artifacts.vesselMesh.bytes.byteLength > 1000);

  // Re-read generated diameter NIfTI to confirm valid header & matching dimensions.
  const diamVol = await readBinaryMaskNifti(artifacts.diameterMap.bytes, { threshold: 0 });
  assert.deepEqual(diamVol.dims, [192, 192, 64]);
  assert.equal(diamVol.foregroundCount, net.vesselVoxelCount);

  // Confirm NIfTI header description strings and calibrated display ranges were written cleanly.
  const diamRaw = gunzipSync(artifacts.diameterMap.bytes);
  const skelRaw = gunzipSync(artifacts.skeletonLabels.bytes);
  const readDescrip = (rawBytes) =>
    Buffer.from(rawBytes.subarray(148, 228)).toString('ascii').replace(/\0+$/, '');
  assert.equal(readDescrip(diamRaw), 'VesselCharter diameter map (mm)');
  assert.equal(
    readDescrip(skelRaw),
    'VesselCharter skeleton labels (1=seg,2=junc,3=end,4=iso)',
  );

  const displayRange = computeDiameterDisplayRange(result.segments, result.diameterMap);
  assert.ok(
    displayRange.minMm > 0 && displayRange.minMm <= displayRange.dataMinMm,
    `Expected strictly positive minMm <= dataMinMm so no vessels are hidden, got ${displayRange.minMm} vs ${displayRange.dataMinMm}`,
  );
  assert.ok(
    Math.abs(displayRange.maxMm - displayRange.dataMaxMm) < 0.05,
    `Normal wide ICA trunk (${displayRange.dataMaxMm.toFixed(2)} mm) should not be over-clipped, got maxMm=${displayRange.maxMm}`,
  );

  const diamView = new DataView(diamRaw.buffer, diamRaw.byteOffset, diamRaw.byteLength);
  assert.ok(Math.abs(diamView.getFloat32(124, true) - displayRange.maxMm) < 1e-4, 'cal_max should match displayRange.maxMm');
  assert.ok(Math.abs(diamView.getFloat32(128, true) - displayRange.minMm) < 1e-4, 'cal_min should match displayRange.minMm');

  // Verify scalar array matches MZ3 vertex count AND per-vertex baked Turbo RGBA values exactly.
  const scalars = buildVesselTreeScalars(result.segments);
  const meshBytes = artifacts.vesselMesh.bytes;
  const meshView = new DataView(meshBytes.buffer, meshBytes.byteOffset, meshBytes.byteLength);
  const meshFaceCount = meshView.getUint32(4, true);
  const meshVertexCount = meshView.getUint32(8, true);
  const meshSkip = meshView.getUint32(12, true);
  assert.equal(scalars.length, meshVertexCount);
  assert.ok(scalars.every((v) => Number.isFinite(v) && v >= 0));

  const colorOffset = 16 + meshSkip + meshFaceCount * 12 + meshVertexCount * 12;
  const span = Math.max(1e-6, displayRange.maxMm - displayRange.minMm);
  for (let i = 0; i < meshVertexCount; i += 1) {
    const expected = sampleColormapRgba(TURBO_COLORMAP, (scalars[i] - displayRange.minMm) / span);
    const actual = [
      meshBytes[colorOffset + i * 4],
      meshBytes[colorOffset + i * 4 + 1],
      meshBytes[colorOffset + i * 4 + 2],
      meshBytes[colorOffset + i * 4 + 3],
    ];
    assert.deepEqual(actual, expected, `Vertex ${i} baked MZ3 RGBA should match scalar Turbo lookup`);
  }
});

test('computeDiameterDisplayRange handles outlier trunks, uniform vessels and micron scales', () => {
  // Multi-scale tree with a 12 mm outlier trunk (> 1.5x p95) clips maxMm to p95.
  const multiSegs = [
    { sampleRadiiMm: Array.from({ length: 95 }, (_, i) => 0.25 + (i / 94) * 0.75) },
    { sampleRadiiMm: [4.5, 5.0, 5.5, 6.0, 6.0] },
  ];
  const multi = computeDiameterDisplayRange(multiSegs);
  assert.ok(multi.minMm > 0 && multi.minMm <= multi.dataMinMm);
  assert.ok(multi.maxMm < 3.0, `Outlier trunk should be clipped by p95, got maxMm=${multi.maxMm}`);
  assert.equal(multi.dataMaxMm, 12);

  // Uniform 4.0 mm cylinder keeps a positive lower bound well below dataMin and preserves dataMax unclipped.
  const uniform = computeDiameterDisplayRange([{ sampleRadiiMm: [1.96, 2.0, 2.02, 2.04, 2.0] }]);
  assert.ok(uniform.minMm > 0 && uniform.minMm < 3.0);
  assert.ok(Math.abs(uniform.maxMm - 4.08) < 0.05);

  // Micron-scale vessels (20-100 um = 0.02-0.10 mm) stay strictly positive and proportional.
  const micro = computeDiameterDisplayRange([{ sampleRadiiMm: [0.01, 0.02, 0.03, 0.04, 0.05] }]);
  assert.ok(micro.minMm > 0 && micro.minMm <= micro.dataMinMm);
  assert.ok(micro.maxMm > 0.08 && micro.maxMm <= 0.101);
});

test('NIfTI spatial units (mm, um, m) convert cleanly without double scaling', async () => {
  const cyl = cylinderPhantom({
    dims: [32, 32, 40],
    spacing: [0.5, 0.5, 0.5],
    radiusMm: 2.0,
    startMm: [8, 8, 4],
    endMm: [8, 8, 16],
  });
  const cases = [
    { code: 2, unitName: 'mm', spacing: [0.5, 0.5, 0.5] },
    { code: 3, unitName: 'um', spacing: [500, 500, 500] },
    { code: 1, unitName: 'm', spacing: [0.0005, 0.0005, 0.0005] },
  ];
  const runs = [];
  for (const c of cases) {
    const [sx, sy, sz] = c.spacing;
    const rawAffine = [
      [sx, 0, 0, 0],
      [0, sy, 0, 0],
      [0, 0, sz, 0],
      [0, 0, 0, 1],
    ];
    const nii = writeNiftiVolume({
      data: cyl.mask,
      dims: cyl.dims,
      affine: rawAffine,
      transforms: {
        qformCode: 0,
        sformCode: 1,
        pixdim0: 1,
        pixDims: [sx, sy, sz],
        quaternB: 0,
        quaternC: 0,
        quaternD: 0,
        qoffsetX: 0,
        qoffsetY: 0,
        qoffsetZ: 0,
        srowX: rawAffine[0],
        srowY: rawAffine[1],
        srowZ: rawAffine[2],
        xyztUnits: c.code,
      },
    });
    const out = await characterizeVesselNifti({ vesselBytes: nii, baseName: `cyl_${c.unitName}.nii` });
    assert.equal(out.result.summary.input.spatialUnit, c.unitName);
    assert.equal(out.result.summary.input.assumedUnitsMm, false);
    for (let a = 0; a < 3; a += 1) {
      assert.ok(Math.abs(out.result.summary.input.voxelSpacingMm[a] - 0.5) < 1e-6);
    }
    runs.push(out.result.summary.network);
  }
  const ref = runs[0];
  for (let i = 1; i < runs.length; i += 1) {
    assert.equal(runs[i].segmentCount, ref.segmentCount);
    assert.ok(Math.abs(runs[i].totalLengthMm - ref.totalLengthMm) < 1e-4);
    assert.ok(Math.abs(runs[i].medianDiameterMm - ref.medianDiameterMm) < 1e-4);
    assert.ok(Math.abs(runs[i].vesselVolumeMm3 - ref.vesselVolumeMm3) < 1e-3);
  }
});

test('diameters and morphometry are invariant to affine flips, permutations and rotations', async () => {
  const bytes = await readFile(LAUSANNE_FIXTURE);
  const vol = await readBinaryMaskNifti(bytes);
  const [sx, sy, sz] = vol.spatial.spacing;

  const base = characterizeVesselMask({
    mask: vol.mask,
    dims: vol.dims,
    spatial: vol.spatial,
  });

  // 1) LAS header (negated X column).
  const lasSpatial = inspectAffine(
    [
      [-sx, 0, 0, 90],
      [0, sy, 0, -40],
      [0, 0, sz, 10],
      [0, 0, 0, 1],
    ],
    2,
  );
  const las = characterizeVesselMask({
    mask: vol.mask,
    dims: vol.dims,
    spatial: lasSpatial,
  });

  // 2) Oblique rotated + permuted orthogonal affine (30 deg rotation around Z + axis permutation).
  const c30 = Math.cos(Math.PI / 6);
  const s30 = Math.sin(Math.PI / 6);
  const rotSpatial = inspectAffine(
    [
      [0, c30 * sy, -s30 * sz, 12],
      [0, s30 * sy, c30 * sz, -8],
      [-sx, 0, 0, 5],
      [0, 0, 0, 1],
    ],
    2,
  );
  const rot = characterizeVesselMask({
    mask: vol.mask,
    dims: vol.dims,
    spatial: rotSpatial,
  });

  for (const [label, variant] of [
    ['LAS', las],
    ['rotated+permuted', rot],
  ]) {
    assert.equal(variant.segments.length, base.segments.length, `${label} segment count`);
    assert.ok(
      Math.abs(variant.summary.network.medianDiameterMm - base.summary.network.medianDiameterMm) < 1e-9,
      `${label} network median diameter drifted`,
    );
    assert.ok(
      Math.abs(variant.summary.network.meanDiameterMm - base.summary.network.meanDiameterMm) < 1e-9,
      `${label} network mean diameter drifted`,
    );
    for (let i = 0; i < base.segments.length; i += 1) {
      assert.ok(
        Math.abs(variant.segments[i].medianDiameterMm - base.segments[i].medianDiameterMm) < 1e-9,
        `${label} segment ${i + 1} median diameter drifted`,
      );
      assert.ok(
        Math.abs(variant.segments[i].equivDiameterMm - base.segments[i].equivDiameterMm) < 1e-9,
        `${label} segment ${i + 1} equivDiameterMm drifted`,
      );
      assert.ok(
        Math.abs(variant.segments[i].lengthMm - base.segments[i].lengthMm) < 1e-9,
        `${label} segment ${i + 1} length drifted`,
      );
    }
  }
});

test('Voronoi Dijkstra assigns all foreground voxels consistently with exact Float64 distances', () => {
  // Anisotropic oblique cylinder where Float32 rounding previously dropped ~10% of heap pops.
  const cyl = cylinderPhantom({
    dims: [40, 40, 48],
    spacing: [0.46875, 0.46875, 0.7],
    radiusMm: 2.2,
    startMm: [6, 6, 6],
    endMm: [13, 12, 26],
  });
  const out = characterizeVesselMask({
    mask: cyl.mask,
    dims: cyl.dims,
    spatial: cyl.spatial,
    parameters: { minSpurLengthMm: 1.0 },
  });
  assert.equal(out.segments.length, 1);
  // Every retained foreground voxel belongs to the single segment (no dropped pops).
  assert.equal(out.segments[0].voxelCount, out.summary.network.vesselVoxelCount);
  // Diameter map has zero unpopulated vessel voxels and matches segment median diameter closely.
  let populated = 0;
  for (let i = 0; i < cyl.mask.length; i += 1) {
    if (cyl.mask[i]) {
      assert.ok(out.diameterMap[i] > 0, `Foreground voxel ${i} left unpopulated`);
      populated += 1;
    }
  }
  assert.equal(populated, out.summary.network.vesselVoxelCount);
});

test('standalone CLI self-check and end-to-end file outputs match programmatic API byte-for-byte', async (t) => {
  const check = checkInstallation();
  assert.equal(check.phantom.segmentCount, 3);
  assert.equal(check.phantom.bifurcationCount, 1);

  const cliSelfCheck = JSON.parse(execFileSync(process.execPath, [CLI_PATH, 'self-check'], { encoding: 'utf8' }));
  assert.equal(cliSelfCheck.phantom.segmentCount, 3);

  const work = await mkdtemp(join(tmpdir(), 'vesselcharter-cli-test-'));
  t.after(() => rm(work, { recursive: true, force: true }));

  const bif = yBifurcationPhantom({ daughterAngleDeg: 90 });
  const roi = sphereRoiMask(bif.dims, bif.spatial.spacing, 12.0);
  const maskPath = join(work, 'bif.nii');
  const brainPath = join(work, 'brain.nii');
  await writeFile(maskPath, packPhantomNifti(bif.mask, bif.dims, bif.spatial.spacing));
  await writeFile(brainPath, packPhantomNifti(roi.mask, bif.dims, bif.spatial.spacing));

  const cliOut = join(work, 'cli-out');
  const apiOut = join(work, 'api-out');

  execFileSync(process.execPath, [CLI_PATH, maskPath, cliOut, '--brain-mask', brainPath], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const apiRes = await characterize({ input: maskPath, brainMask: brainPath, output: apiOut });
  assert.ok(apiRes.summary.roi !== null);

  const cliFiles = (await readdir(cliOut)).sort();
  const apiFiles = (await readdir(apiOut)).sort();
  assert.deepEqual(cliFiles, apiFiles);

  for (const name of cliFiles) {
    const a = await readFile(join(cliOut, name));
    const b = await readFile(join(apiOut, name));
    assert.equal(Buffer.compare(a, b), 0, `CLI and API output ${name} must be byte-identical`);
  }
});
