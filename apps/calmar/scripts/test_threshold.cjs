#!/usr/bin/env node
// Pure-JS tests for web/js/modules/threshold.js. Pins:
//   - applyThreshold (absolute / percentile, one-sided / symmetric, with
//     minClusterVoxels post-CC cleanup).
//   - quantileAbsValue helper used to pick the threshold under percentile
//     mode.
// All cases use synthetic phantoms so the math is unambiguous.

const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

(async () => {
  const moduleUrl = pathToFileURL(
    path.resolve(__dirname, '..', 'web/js/modules/threshold.js')
  );
  const { applyThreshold, applyThresholdDetailed, quantileAbsValue } = await import(moduleUrl);

  // ---- quantileAbsValue ----
  // 95th percentile of |x| in [0..99] is |x|=95 (linear interpolation).
  {
    const arr = new Float32Array(100);
    for (let i = 0; i < 100; i++) arr[i] = i - 50;   // [-50..49]
    // |arr| ranges 0..50 with two of each value (except 50). 95th percentile
    // of these 100 |values| sorted is around 47.55 (interpolation between
    // 95th and 96th element of the sorted absolute values).
    const v95 = quantileAbsValue(arr, 0.95);
    assert.ok(v95 >= 47 && v95 <= 49,
      `95th percentile of |arr|: expected ~48, got ${v95}`);
    // 100th percentile = max(|arr|) = 50.
    assert.equal(quantileAbsValue(arr, 1.0), 50);
    // 0th percentile = min(|arr|) = 0.
    assert.equal(quantileAbsValue(arr, 0.0), 0);
  }

  // ---- applyThreshold: absolute, one-sided ----
  // 4x4x4 phantom: ramp 0..63. threshold=20 (one-sided, positive only)
  // -> voxels [21..63] survive = 43 voxels (no min-cluster filter at this
  // step).
  {
    const dims = [4, 4, 4];
    const data = new Float32Array(64);
    for (let i = 0; i < 64; i++) data[i] = i;
    const mask = applyThreshold(data, dims, { mode: 'absolute', value: 20, symmetric: false });
    let count = 0;
    for (let i = 0; i < 64; i++) count += mask[i];
    assert.equal(count, 43, `one-sided abs > 20: expected 43, got ${count}`);
    // i=20 stays out (>= treats > strictly), i=21 is in.
    assert.equal(mask[20], 0);
    assert.equal(mask[21], 1);
  }

  // ---- applyThreshold: absolute, symmetric ----
  // Same phantom shifted so we have negatives. threshold=10 symmetric ->
  // |x| > 10. Values are [-32..31]. Negative side has 22 voxels with
  // |x| in [11..32] (i.e. -32 through -11); positive side has 21 voxels
  // with x in [11..31]. Total = 43.
  {
    const dims = [4, 4, 4];
    const data = new Float32Array(64);
    for (let i = 0; i < 64; i++) data[i] = i - 32;
    const mask = applyThreshold(data, dims, { mode: 'absolute', value: 10, symmetric: true });
    let count = 0;
    for (let i = 0; i < 64; i++) count += mask[i];
    assert.equal(count, 43, `symmetric |x| > 10: expected 43, got ${count}`);
    assert.equal(mask[32 + 11], 1);          // value = 11, |11| > 10
    assert.equal(mask[32 + 10], 0);          // value = 10, |10| not > 10
    assert.equal(mask[32 - 11], 1);          // value = -11
    assert.equal(mask[32 - 10], 0);          // value = -10
  }

  // ---- applyThreshold: percentile mode ----
  // 4x4x4 with values 0..63. 50th-percentile-of-|x| -> ~31.5 -> > 31 -> 32 voxels.
  {
    const dims = [4, 4, 4];
    const data = new Float32Array(64);
    for (let i = 0; i < 64; i++) data[i] = i;
    const mask = applyThreshold(data, dims, { mode: 'percentile', value: 0.5, symmetric: false });
    let count = 0;
    for (let i = 0; i < 64; i++) count += mask[i];
    assert.ok(count >= 30 && count <= 34,
      `50th percentile threshold: expected ~32 voxels, got ${count}`);
  }

  // ---- applyThreshold: minClusterVoxels removes small components ----
  // 6x6x6 with two CCs: a 2x2x2 cube (8 voxels) all at +20 plus a stray
  // single voxel at +25 in the far corner. With threshold=10 + minCluster=5,
  // the singleton is dropped, the cube survives.
  {
    const dims = [6, 6, 6];
    const data = new Float32Array(216);
    for (let z = 0; z < 2; z++)
      for (let y = 0; y < 2; y++)
        for (let x = 0; x < 2; x++)
          data[x + y * 6 + z * 36] = 20;
    data[5 + 5 * 6 + 5 * 36] = 25;        // 26-conn-disconnected singleton
    const mask = applyThreshold(data, dims, {
      mode: 'absolute', value: 10, symmetric: false, minClusterVoxels: 5
    });
    let count = 0;
    for (let i = 0; i < 216; i++) count += mask[i];
    assert.equal(count, 8, `min-cluster=5 keeps cube only: expected 8, got ${count}`);
    assert.equal(mask[5 + 5 * 6 + 5 * 36], 0, 'singleton must be dropped');

    const detailed = applyThresholdDetailed(data, dims, {
      mode: 'absolute', value: 10, symmetric: false, minClusterVoxels: 5
    });
    assert.equal(detailed.rawCount, 9,
      'applyThresholdDetailed reports pre-cluster survivor count');
    assert.equal(detailed.count, 8,
      'applyThresholdDetailed reports post-cluster survivor count');
    assert.equal(detailed.removedByCluster, 1,
      'applyThresholdDetailed reports voxels removed by cluster cleanup');
    assert.equal(detailed.threshold, 10,
      'applyThresholdDetailed reports the numeric cutoff');
  }

  // ---- applyThreshold: empty / all-zero input -> all-zero output ----
  {
    const dims = [4, 4, 4];
    const zero = new Float32Array(64);
    const mask = applyThreshold(zero, dims, { mode: 'absolute', value: 0.5 });
    let sum = 0;
    for (let i = 0; i < 64; i++) sum += mask[i];
    assert.equal(sum, 0);
  }

  // ---- applyThreshold: validates inputs ----
  {
    assert.throws(
      () => applyThreshold(new Float32Array(8), [4, 4, 4], { mode: 'absolute', value: 1 }),
      /size|length|dim/i,
      'dim mismatch must throw'
    );
    assert.throws(
      () => applyThreshold(new Float32Array(64), [4, 4, 4], { mode: 'rank', value: 1 }),
      /mode/i,
      'unknown mode must throw'
    );
  }

  console.log('threshold OK: 5 functional cases + detailed stats + quantileAbsValue + input validation.');
})().catch(err => {
  console.error(err.stack || err.message);
  process.exit(1);
});
