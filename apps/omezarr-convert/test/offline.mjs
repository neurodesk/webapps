import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { unzipSync } from 'fflate';
import { expect } from '@playwright/test';
import { openSource } from '@neurodesk/omezarr-convert';
import { archiveStore, readBackLevels, rootAttributes, schemaErrors, sha256 } from '../../../packages/omezarr-convert/validation/checks.mjs';

// The installed desktop app converts the NIfTI fixture to OME-Zarr 0.5; its level 0, read
// back by zarrita, holds the fixture's stored voxels, and its metadata passes the schema.
export async function verifyOffline(page, { fixture, download }) {
  await page.locator('#imageInput').setInputFiles(fixture);
  await expect(page.locator('#runButton')).toBeEnabled({ timeout: 60000 });
  await page.locator('#runButton').click();
  await expect(page.locator('#statusText')).toHaveText('OME-Zarr ready', { timeout: 300000 });
  const result = await download('#resultList .nd-volume-toggle:first-child .nd-download-btn');
  assert.match(result.filename, /\.ozx$/);
  const map = archiveStore(unzipSync(new Uint8Array(result.bytes)));
  assert.deepEqual(schemaErrors(rootAttributes(map, '0.5'), '0.5'), []);
  const source = await openSource([new File([await readFile(fixture)], basename(fixture))]);
  const { levels } = await readBackLevels(map);
  const { t, z, y, x } = source.shape;
  const voxels = new levels[0].data.constructor(t * z * y * x);
  for (let frame = 0; frame < t; frame += 1) for (let slice = 0; slice < z; slice += 1) voxels.set(await source.readPlane(frame, 0, slice), (frame * z + slice) * y * x);
  assert.equal(levels[0].sha256, sha256(voxels));
  return { filename: result.filename, bytes: result.bytes.length };
}
