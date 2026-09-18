import { estimateHdBetPatches, windowSteps } from './HdBetEstimate.js';

const BROWSER_PATCH = [128, 128, 64];

describe('windowSteps', () => {
  test('matches the nnU-Net cases pinned in hdbet.rs', () => {
    // Same assertions as `window_steps_match_nnunet` in src/bet/hdbet.rs.
    expect(windowSteps(110, 64, 0.5)).toBe(3);    // nnU-Net docstring example: 0, 23, 46
    expect(windowSteps(205, 96, 0.5)).toBe(4);    // 0, 36, 73, 109
    expect(windowSteps(192, 192, 0.5)).toBe(1);
    expect(windowSteps(205, 192, 1.0)).toBe(2);   // 0, 13
  });

  test('a volume no larger than one patch is a single window', () => {
    expect(windowSteps(64, 128, 0.5)).toBe(1);
    expect(windowSteps(128, 128, 0.5)).toBe(1);
  });
});

describe('estimateHdBetPatches', () => {
  test('matches the 36 patches a real browser run reported', () => {
    // sub-1 qsm-forward phantom, 164x205x205 @ 1 mm. The run logged exactly 36/36, and this
    // volume is near-full-FOV so the non-zero crop removes nothing.
    expect(estimateHdBetPatches([164, 205, 205], [1, 1, 1], BROWSER_PATCH, 0.5)).toBe(36);
  });

  test('less overlap never costs more, and 25% is a real saving', () => {
    const dims = [164, 205, 205], vs = [1, 1, 1];
    const half = estimateHdBetPatches(dims, vs, BROWSER_PATCH, 0.5);
    const quarter = estimateHdBetPatches(dims, vs, BROWSER_PATCH, 0.75);
    const none = estimateHdBetPatches(dims, vs, BROWSER_PATCH, 1.0);

    expect(half).toBe(36);
    expect(quarter).toBe(16);       // 2.25x less work than the default
    // Steps land on whole windows, so coarser strides can tie rather than drop further — the
    // modal shows the real number precisely because the saving is not proportional to the knob.
    expect(none).toBe(16);
    expect(quarter).toBeLessThanOrEqual(half);
    expect(none).toBeLessThanOrEqual(quarter);
  });

  test('counts the 1 mm resampled grid, not the acquired one', () => {
    // HD-BET works at 1 mm, so cost tracks physical extent rather than voxel count. Sub-mm data
    // is *downsampled* and gets cheaper; low-res data is upsampled and gets dramatically dearer
    // — 2 mm here is 360 patches against 36, which is the case worth warning a user about.
    const dims = [164, 205, 205];
    expect(estimateHdBetPatches(dims, [0.5, 0.5, 0.5], BROWSER_PATCH, 0.5)).toBe(3);
    expect(estimateHdBetPatches(dims, [1, 1, 1], BROWSER_PATCH, 0.5)).toBe(36);
    expect(estimateHdBetPatches(dims, [2, 2, 2], BROWSER_PATCH, 0.5)).toBe(360);
  });

  test('a volume smaller than one patch still runs one', () => {
    expect(estimateHdBetPatches([32, 32, 16], [1, 1, 1], BROWSER_PATCH, 0.5)).toBe(1);
  });
});
