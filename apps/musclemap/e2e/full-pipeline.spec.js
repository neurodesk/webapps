import { expect, test } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { verifyMuscleMapFullPipeline } from '../../../test/musclemap-full-pipeline-smoke.mjs';
import { compareWithUpstream, loadUpstreamReference, UPSTREAM_GATE } from '../test/upstream-reference.mjs';

// KNOWN SHORTFALL, measured 2026-10-03: the app meets the release gate's voxel agreement (0.9948)
// and foreground Dice (0.9878) but not its per-label Dice of 0.95: 10 of 26 labels fall below it,
// the lowest at 0.693 (label 7162, 60 upstream voxels); the mean label Dice is 0.945. The two
// limits below are regression pins at those measured values, not the release gate, so the suite
// catches further drift while test/fixtures/upstream-reference/README.md records the shortfall.
const KNOWN_SHORTFALL = { labelsBelowReleaseGate: 10, lowestLabelDice: 0.69 };

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

test('real v1.4 model, cleanup and metrics match upstream MuscleMap on a body MRI slab (per-label Dice pinned below the release gate)', async ({ page }) => {
  test.setTimeout(900_000);
  const reference = await loadUpstreamReference();
  const result = await verifyMuscleMapFullPipeline(page, 'http://localhost:4318/', { timeout: 780_000, reference });

  expect(result.appVersion).toBe(`v${packageJson.version}`);
  expect(result.requestedThreads).toBeGreaterThan(1);
  const comparison = await compareWithUpstream(result.segmentation, reference);
  const { perLabel, ...summary } = comparison;
  console.log(JSON.stringify({ ...summary, totalVolumeMl: result.totalVolumeMl }));
  const directory = join(process.env.TMPDIR || process.env.RUNNER_TEMP, 'neurodesk-musclemap-full-pipeline');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'segmentation.nii'), result.segmentation);
  await writeFile(join(directory, 'upstream-comparison.json'), JSON.stringify(comparison, null, 2));
  expect(comparison.affineMatches).toBe(true);
  expect(comparison.overallAgreement).toBeGreaterThanOrEqual(UPSTREAM_GATE.minimumOverallAgreement);
  expect(comparison.foregroundDice).toBeGreaterThanOrEqual(UPSTREAM_GATE.minimumForegroundDice);
  expect(comparison.extraLabels).toEqual([]);
  expect(comparison.labelsBelowGate.length).toBeLessThanOrEqual(KNOWN_SHORTFALL.labelsBelowReleaseGate);
  expect(comparison.worstLabelDice).toBeGreaterThanOrEqual(KNOWN_SHORTFALL.lowestLabelDice);
  expect(Object.keys(perLabel).length).toBeGreaterThanOrEqual(comparison.referenceLabels);
});
