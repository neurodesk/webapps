#!/usr/bin/env node
// Pure-JS tests for web/js/modules/fc-weighted-sum.js. Pins the
// weighted-sum math + the metadata-decoding helper used by the worker
// to convert the worker-side network overlap into a brain-wide t-map.

const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

(async () => {
  const moduleUrl = pathToFileURL(
    path.resolve(__dirname, '..', 'web/js/modules/fc-weighted-sum.js')
  );
  const {
    fcWeightedSum,
    summaryToNetworkWeights,
    decodeFcPack,
    float16ToFloat32Array,
    parcelResultToChannelWeights,
    rowMajorToNiftiOrder
  } = await import(moduleUrl);

  // ---- decodeFcPack: split a packed .bin into 7 channel views ----
  // 7 channels x 4 voxels each = 28 floats; values 0..27 so we can
  // verify the per-channel splits land at the right byte offsets.
  {
    const voxelsPerMap = 4;
    const buf = new Float32Array(7 * voxelsPerMap);
    for (let i = 0; i < buf.length; i++) buf[i] = i;
    const index = {
      shape: [7, voxelsPerMap, 1, 1],
      voxelsPerMap,
      networkLabels: { 1: 'Visual', 2: 'Somatomotor', 3: 'DorsalAttention',
                       4: 'VentralAttention', 5: 'Limbic', 6: 'Frontoparietal',
                       7: 'Default' },
      dtype: 'float32'
    };
    const pack = decodeFcPack(buf.buffer, index);
    assert.equal(pack.tMaps.length, 7, 'must split into 7 t-maps');
    for (let k = 0; k < 7; k++) {
      assert.equal(pack.tMaps[k].length, voxelsPerMap);
      for (let v = 0; v < voxelsPerMap; v++) {
        assert.equal(pack.tMaps[k][v], k * voxelsPerMap + v,
          `channel ${k} voxel ${v} byte-offset`);
      }
    }
    // network-name lookup preserved.
    assert.equal(pack.byNetwork['Visual'], pack.tMaps[0]);
    assert.equal(pack.byNetwork['Default'], pack.tMaps[6]);
  }

  // ---- decodeFcPack: arbitrary channel counts + float16 assets ----
  {
    const halfBits = new Uint16Array([0x3c00, 0x4000, 0xc200, 0x4400, 0x0000, 0x3800]);
    const decoded = float16ToFloat32Array(halfBits);
    assert.deepEqual(Array.from(decoded), [1, 2, -3, 4, 0, 0.5]);
    const index = {
      shape: [3, 2, 1, 1],
      voxelsPerMap: 2,
      channelLabels: { 1: 'Parcel 1', 2: 'Parcel 2', 3: 'Parcel 3' },
      dtype: 'float16',
      voxelOrder: 'nifti'
    };
    const pack = decodeFcPack(halfBits.buffer, index);
    assert.equal(pack.tMaps.length, 3, 'must split arbitrary channel count');
    assert.equal(pack.tMaps[1][0], -3);
    assert.equal(pack.byChannel['Parcel 3'], pack.tMaps[2]);
  }

  // ---- decodeFcPack: row-major asset bytes are converted to NIfTI order ----
  // The Yeo7 development FC pack was emitted by NumPy tofile(), which stores
  // each [X,Y,Z] map with z as the fastest axis. The app writes NIfTI and
  // runs connected components in x-fast order, so decodeFcPack must transpose
  // the map at the asset boundary.
  {
    const dims = [2, 3, 4];
    const voxelsPerMap = dims[0] * dims[1] * dims[2];
    const raw = new Float32Array(7 * voxelsPerMap);
    const rowMajorIndex = (x, y, z) => x * dims[1] * dims[2] + y * dims[2] + z;
    const niftiIndex = (x, y, z) => x + y * dims[0] + z * dims[0] * dims[1];
    for (let k = 0; k < 7; k++) {
      for (let x = 0; x < dims[0]; x++)
        for (let y = 0; y < dims[1]; y++)
          for (let z = 0; z < dims[2]; z++)
            raw[k * voxelsPerMap + rowMajorIndex(x, y, z)] =
              1000 * k + 100 * x + 10 * y + z;
    }
    const index = {
      shape: [7, ...dims],
      voxelsPerMap,
      dtype: 'float32',
      voxelOrder: 'row-major'
    };
    const pack = decodeFcPack(raw.buffer, index);
    assert.equal(pack.tMaps.length, 7);
    for (let k = 0; k < 7; k++) {
      for (let x = 0; x < dims[0]; x++)
        for (let y = 0; y < dims[1]; y++)
          for (let z = 0; z < dims[2]; z++)
            assert.equal(
              pack.tMaps[k][niftiIndex(x, y, z)],
              1000 * k + 100 * x + 10 * y + z,
              `channel ${k} voxel ${x},${y},${z} must be x-fast after decode`
            );
    }

    const direct = rowMajorToNiftiOrder(raw.subarray(0, voxelsPerMap), dims);
    assert.equal(direct[niftiIndex(1, 2, 3)], 123);
  }

  // ---- summaryToNetworkWeights: convert summarizeNetworkOverlap output
  // into the (length-7) weight vector aligned to the FC pack's channel order.
  // 'Unassigned' weight is dropped (no FC channel for it).
  {
    const summary = {
      totalLesionVoxels: 100,
      networks: [
        { network: 'Default',     voxelsInLesion: 60, fractionOfLesion: 0.6, parcels: [7] },
        { network: 'Visual',      voxelsInLesion: 30, fractionOfLesion: 0.3, parcels: [1] },
        { network: 'Unassigned',  voxelsInLesion: 10, fractionOfLesion: 0.1, parcels: [99] }
      ]
    };
    const networkOrder = ['Visual', 'Somatomotor', 'DorsalAttention',
                          'VentralAttention', 'Limbic', 'Frontoparietal', 'Default'];
    const weights = summaryToNetworkWeights(summary, networkOrder);
    assert.equal(weights.length, 7);
    assert.ok(Math.abs(weights[0] - 0.3) < 1e-6);   // Visual (Float32 precision)
    assert.ok(Math.abs(weights[6] - 0.6) < 1e-6);   // Default
    for (const k of [1, 2, 3, 4, 5]) {
      assert.equal(weights[k], 0, `network ${networkOrder[k]} not in summary -> zero weight`);
    }
  }

  // ---- fcWeightedSum: per-voxel out[v] = Σ weight[k] × tMap[k][v] ----

  // (1) zero weights -> zero output (regardless of tMap content).
  {
    const dims = [4, 4, 4];
    const N = 64;
    const tMaps = Array.from({ length: 7 }, (_, k) => {
      const a = new Float32Array(N);
      for (let v = 0; v < N; v++) a[v] = (k + 1) * (v + 1);
      return a;
    });
    const weights = new Float32Array(7);
    const out = fcWeightedSum(weights, tMaps, dims);
    for (let v = 0; v < N; v++) {
      assert.equal(out[v], 0, `zero weights -> zero out at v=${v}`);
    }
  }

  // ---- parcelResultToChannelWeights: Schaefer-style parcel weighting ----
  {
    const parcelResult = {
      totalLesionVoxels: 10,
      parcels: [
        { label: 7, voxelsInLesion: 6, fractionOfLesion: 0.6 },
        { label: 22, voxelsInLesion: 4, fractionOfLesion: 0.4 }
      ]
    };
    const { weights, labels } = parcelResultToChannelWeights(parcelResult, {
      7: 'LH_Vis_7',
      22: 'LH_SomMot_22',
      99: 'RH_Default_99'
    });
    assert.deepEqual(labels, ['7', '22', '99']);
    assert.ok(Math.abs(weights[0] - 0.6) < 1e-6);
    assert.ok(Math.abs(weights[1] - 0.4) < 1e-6);
    assert.equal(weights[2], 0);
  }

  // (2) Identity case: weight = [0, ..., 0, 1, 0, ...] picks tMap[k] verbatim.
  {
    const dims = [3, 3, 3];
    const N = 27;
    const tMaps = Array.from({ length: 7 }, () => new Float32Array(N));
    const focus = 3;   // VentralAttention
    for (let v = 0; v < N; v++) tMaps[focus][v] = v + 1;
    const weights = new Float32Array(7);
    weights[focus] = 1.0;
    const out = fcWeightedSum(weights, tMaps, dims);
    for (let v = 0; v < N; v++) {
      assert.equal(out[v], v + 1, `identity-weight on focus channel: v=${v}`);
    }
  }

  // (3) Linearity: out[v] = w0*t0[v] + w1*t1[v] for two non-zero networks.
  {
    const dims = [2, 2, 2];
    const N = 8;
    const tMaps = Array.from({ length: 7 }, () => new Float32Array(N));
    for (let v = 0; v < N; v++) {
      tMaps[0][v] = v;        // Visual: 0..7
      tMaps[6][v] = -v;       // Default: 0..-7
    }
    const w = new Float32Array(7);
    w[0] = 0.4; w[6] = 0.6;
    const out = fcWeightedSum(w, tMaps, dims);
    for (let v = 0; v < N; v++) {
      const expected = 0.4 * v + 0.6 * (-v);
      assert.ok(Math.abs(out[v] - expected) < 1e-6,
        `linearity: v=${v} expected ${expected} got ${out[v]}`);
    }
  }

  // (4) Length / shape mismatch must throw, not silently misindex.
  {
    const tMaps = Array.from({ length: 7 }, () => new Float32Array(8));
    assert.throws(
      () => fcWeightedSum(new Float32Array(7), tMaps, [4, 4, 4]),
      /size|length|dim/i,
      'dim mismatch (expected 64, got 8) must throw'
    );
    assert.throws(
      () => fcWeightedSum(new Float32Array(6), tMaps, [2, 2, 2]),
      /weight|length|7/i,
      'weights length != 7 must throw'
    );
    const wrongTMaps = Array.from({ length: 6 }, () => new Float32Array(8));
    assert.throws(
      () => fcWeightedSum(new Float32Array(7), wrongTMaps, [2, 2, 2]),
      /map|length|7/i,
      'tMaps array length != 7 must throw'
    );
  }

  console.log('fc-weighted-sum OK: generic channel decode, float16, parcel weights, weighted sums.');
})().catch(err => {
  console.error(err.stack || err.message);
  process.exit(1);
});
