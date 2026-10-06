import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { verifyMuscleMapFullPipeline } from '../../../test/musclemap-full-pipeline-smoke.mjs';

function niftiVoxels(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    datatype: view.getInt16(70, true),
    dims: [view.getInt16(42, true), view.getInt16(44, true), view.getInt16(46, true)],
    voxels: bytes.subarray(Math.ceil(view.getFloat32(108, true))),
  };
}

async function dragAcrossCentre(page) {
  const box = await page.locator('#gl1').boundingBox();
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x - box.width / 6, y);
  await page.mouse.down();
  for (let step = 1; step <= 10; step++) await page.mouse.move(x - box.width / 6 + (step * box.width) / 30, y + step);
  await page.mouse.up();
}

test('edits a generated segmentation in the viewer and downloads the edited label map', async ({ page }) => {
  test.setTimeout(300_000);
  await verifyMuscleMapFullPipeline(page, 'http://localhost:4318/');
  await page.locator('.view-tab[data-view="axial"]').click();

  const row = page.locator('.segmentation-result-row').first();
  const editor = page.locator('nd-mask-editor');
  const label = row.locator('.segmentation-result-label');
  await expect(label).toHaveText('release-smoke-mri.nii segmentation');
  const pipelineDownload = page.waitForEvent('download');
  await row.getByRole('button', { name: 'Download' }).click();
  const pipelineName = (await pipelineDownload).suggestedFilename();
  const editTarget = new Uint8Array(await page.evaluate(async () => [...new Uint8Array(await window.app.segmentationResults[0].editFile.arrayBuffer())]));

  await row.getByRole('button', { name: 'Edit' }).click();
  await expect(editor).toBeVisible();
  await expect(page.locator('#statusText')).toContainText('Editing release-smoke-mri.nii segmentation');
  await expect(row.getByRole('button', { name: 'Edit' })).toBeDisabled();
  await dragAcrossCentre(page);
  await editor.getByRole('button', { name: 'Cancel' }).click();
  await expect(editor).toBeHidden();
  await expect(label).toHaveText('release-smoke-mri.nii segmentation');
  await expect(page.locator('#statusText')).toHaveText('Ready');

  await row.getByRole('button', { name: 'Edit' }).click();
  await expect(editor).toBeVisible();
  await dragAcrossCentre(page);
  await editor.getByRole('button', { name: 'Apply' }).click();
  await expect(editor).toBeHidden();
  await expect(label).toHaveText('release-smoke-mri.nii segmentation (edited)');

  const editedDownload = page.waitForEvent('download');
  await row.getByRole('button', { name: 'Download' }).click();
  const download = await editedDownload;
  expect(download.suggestedFilename()).toBe(pipelineName);
  const edited = niftiVoxels(new Uint8Array(await readFile(await download.path())));
  const original = niftiVoxels(editTarget);
  expect(edited.datatype).toBe(2);
  expect(edited.dims).toEqual([32, 32, 1]);
  expect(edited.voxels.length).toBe(original.voxels.length);
  expect(Buffer.compare(Buffer.from(edited.voxels), Buffer.from(original.voxels))).not.toBe(0);
  const overlay = await page.evaluate(() => window.app.nv.volumes.length);
  expect(overlay).toBe(2);

  await row.getByRole('button', { name: 'Edit' }).click();
  await expect(editor).toBeVisible();
  await page.locator('#clearResults').click();
  await expect(editor).toBeHidden();
  await expect(page.locator('.segmentation-result-row')).toHaveCount(0);
});
