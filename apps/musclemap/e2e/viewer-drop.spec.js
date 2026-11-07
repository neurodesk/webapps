import { expect, test } from '@playwright/test';

function createInt16Nifti(values, voxelSize = [10, 10, 10]) {
  const headerSize = 352;
  const buffer = Buffer.alloc(headerSize + values.length * 2);
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  view.setInt32(0, 348, true);
  view.setInt16(40, 3, true);
  view.setInt16(42, values.length, true);
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
  values.forEach((value, index) => view.setInt16(headerSize + index * 2, value, true));
  return buffer;
}

async function dropNifti(page, target, name) {
  const bytes = Array.from(createInt16Nifti([10, 20, 30]));
  const box = await target.boundingBox();
  await target.dispatchEvent('drop', {
    dataTransfer: await page.evaluateHandle(([fileName, fileBytes]) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array(fileBytes)], fileName, { type: 'application/octet-stream' }));
      return transfer;
    }, [name, bytes]),
    bubbles: true,
    cancelable: true,
    clientX: box.x + box.width / 2,
    clientY: box.y + box.height / 2
  });
}

for (const [label, selector] of [
  ['the sidebar', '#musclemap-section-1'],
  ['the NiiVue canvas', '#gl1'],
  ['the technical log', '#musclemap-log']
]) {
  test(`a NIfTI dropped on ${label} becomes the segmentation input`, async ({ page }) => {
    await page.goto('/index.html');
    await expect(page.locator('#runSegmentation')).toBeDisabled();

    await dropNifti(page, page.locator(selector), 'subject_T1w.nii');

    await expect(page.locator('#fileList .file-name')).toHaveText(['subject_T1w.nii']);
    await expect(page.locator('#runSegmentation')).toBeEnabled();
    await expect.poll(() => page.evaluate(() => window.app.fileIOController.getActiveFile()?.name)).toBe('subject_T1w.nii');
  });
}

test('a later drop replaces the inputs and Undo brings them back', async ({ page }) => {
  await page.goto('/index.html');
  await dropNifti(page, page.locator('#gl1'), 'first_T1w.nii');
  await expect(page.locator('#fileList .file-name')).toHaveText(['first_T1w.nii']);
  await dropNifti(page, page.locator('#gl1'), 'second_T1w.nii');
  await expect(page.locator('#fileList .file-name')).toHaveText(['second_T1w.nii']);
  await page.locator('#status .nd-status-undo').click();
  await expect(page.locator('#fileList .file-name')).toHaveText(['first_T1w.nii']);
});

test('Undo after a drop restores every file added before it, not just the last batch', async ({ page }) => {
  await page.goto('/index.html');
  await expect(page.locator('#fileInput').locator('xpath=..')).toBeHidden();
  const input = page.locator('#fileInput');
  const nifti = name => ({ name, mimeType: 'application/octet-stream', buffer: createInt16Nifti([10, 20, 30]) });
  await input.setInputFiles(nifti('a_T1w.nii'));
  await input.setInputFiles(nifti('b_T1w.nii'));
  await expect(page.locator('#fileList .file-name')).toHaveText(['a_T1w.nii', 'b_T1w.nii']);
  await dropNifti(page, page.locator('#gl1'), 'c_T1w.nii');
  await expect(page.locator('#fileList .file-name')).toHaveText(['c_T1w.nii']);
  await page.locator('#status .nd-status-undo').click();
  await expect(page.locator('#fileList .file-name')).toHaveText(['a_T1w.nii', 'b_T1w.nii']);
});

test('Undo after a drop leaves out files removed before it', async ({ page }) => {
  await page.goto('/index.html');
  const input = page.locator('#fileInput');
  const nifti = name => ({ name, mimeType: 'application/octet-stream', buffer: createInt16Nifti([10, 20, 30]) });
  await input.setInputFiles(nifti('a_T1w.nii'));
  await input.setInputFiles(nifti('b_T1w.nii'));
  await page.locator('#fileList .file-remove').first().click();
  await expect(page.locator('#fileList .file-name')).toHaveText(['b_T1w.nii']);
  await dropNifti(page, page.locator('#gl1'), 'c_T1w.nii');
  await expect(page.locator('#fileList .file-name')).toHaveText(['c_T1w.nii']);
  await page.locator('#status .nd-status-undo').click();
  await expect(page.locator('#fileList .file-name')).toHaveText(['b_T1w.nii']);
});

test('a NIfTI chosen while the viewer starts is loaded once it is ready', async ({ page }) => {
  // Hold animation frames so the viewer setup, which waits for one, cannot finish.
  await page.addInitScript(() => {
    const held = [];
    const requestFrame = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback) => {
      if (window.releaseFrames) return requestFrame(callback);
      held.push(callback);
      return held.length;
    };
    window.releaseFrames = null;
    window.releaseHeldFrames = () => {
      window.releaseFrames = true;
      for (const callback of held.splice(0)) requestFrame(callback);
    };
  });
  await page.goto('/index.html');
  await expect.poll(() => page.evaluate(() => Boolean(window.app?.fileIOController))).toBe(true);

  await page.locator('#fileInput').setInputFiles({
    name: 'early_T1w.nii',
    mimeType: 'application/octet-stream',
    buffer: createInt16Nifti([10, 20, 30]),
  });
  await page.evaluate(() => window.releaseHeldFrames());

  await expect(page.locator('#fileList .file-name')).toHaveText(['early_T1w.nii']);
  await expect.poll(() => page.evaluate(() => window.app.fileIOController.getActiveFile()?.name)).toBe('early_T1w.nii');
});
