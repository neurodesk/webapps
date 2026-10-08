import { expect, test } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { verifyMuscleMapFullPipeline } from '../../../test/musclemap-full-pipeline-smoke.mjs';
import { compareWithUpstream, loadUpstreamReference, UPSTREAM_GATE } from '../test/upstream-reference.mjs';

// The release gate of scripts/compare_upstream_output.py against upstream MuscleMap's own labels
// for the same slab: voxel agreement, foreground Dice and Dice for every label upstream found.
const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

test('real v1.4 model, cleanup and metrics match upstream MuscleMap on a body MRI slab under the release gate', async ({ page }) => {
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
  expect(comparison.referenceLabels).toBe(26);
  expect(comparison.labelsBelowGate).toEqual([]);
  expect(comparison.worstLabelDice).toBeGreaterThanOrEqual(UPSTREAM_GATE.minimumLabelDice);
  expect(Object.keys(perLabel).length).toBeGreaterThanOrEqual(comparison.referenceLabels);
});
