import { expect, test } from '@playwright/test';

function createInt16Nifti(labels, voxelSize = [10, 10, 10]) {
  const headerSize = 352;
  const buffer = Buffer.alloc(headerSize + labels.length * 2);
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  view.setInt32(0, 348, true);
  view.setInt16(40, 3, true);
  view.setInt16(42, labels.length, true);
  view.setInt16(44, 1, true);
  view.setInt16(46, 1, true);
  view.setInt16(48, 1, true);
  view.setInt16(70, 4, true);
  view.setInt16(72, 16, true);
  view.setFloat32(80, voxelSize[0], true);
  view.setFloat32(84, voxelSize[1], true);
  view.setFloat32(88, voxelSize[2], true);
  view.setFloat32(108, headerSize, true);
  view.setFloat32(112, 1, true);
  view.setInt16(254, 1, true);
  view.setFloat32(280, voxelSize[0], true);
  view.setFloat32(300, voxelSize[1], true);
  view.setFloat32(320, voxelSize[2], true);
  buffer.write('n+1\0', 344, 'binary');
  labels.forEach((label, index) => view.setInt16(headerSize + index * 2, label, true));
  return buffer;
}

test('runs metrics only and restores OpenRecon labels from an uploaded NIfTI', async ({ page }) => {
  await page.goto('/index.html');

  await page.locator('#fileInput').setInputFiles({
    name: 'subject_dseg.nii',
    mimeType: 'application/octet-stream',
    buffer: createInt16Nifti([0, 331, 2141])
  });

  const contract = page.locator('.file-entry-controls select').nth(1);
  await expect(contract).toHaveValue('musclemap-wholebody-v1.4|auto');
  await expect(page.locator('#runSegmentation')).toBeDisabled();
  await expect(page.locator('#calculateMetrics')).toBeEnabled();

  await page.locator('#calculateMetrics').click();

  await expect(page.locator('#metricsSummary')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('#metricsSummary')).toContainText('2');
  await expect(page.locator('#metricsSummary')).toContainText('2.0');
  await expect(page.locator('#consoleOutput')).toContainText(
    'Detected OpenRecon int12 labels for musclemap-wholebody-v1.4; restored official MuscleMap label mapping.'
  );
  await expect.poll(() => page.evaluate(() => window.app.getUploadedSegmentationSources()[0].labelEncoding)).toBe('sparse');
  await expect(page.locator('.segmentation-result-row .nd-edit-btn')).toHaveCount(0);
  const normalizedLabels = await page.evaluate(async () => {
    const [{ file }] = window.app.getUploadedSegmentationSources();
    const data = await file.arrayBuffer();
    const view = new DataView(data);
    const offset = Math.ceil(view.getFloat32(108, true));
    return [0, 1, 2].map(index => view.getUint16(offset + index * 2, true));
  });
  expect(normalizedLabels).toEqual([0, 1101, 7132]);
});
