import { expect, test } from '@playwright/test';

// Minimal valid 4x4x4 uint8 NIfTI-1 binary mask (352-byte header + 64-byte payload = 416 bytes).
function makeSyntheticNiftiMask(fillValue = 1) {
  const buf = new ArrayBuffer(352 + 64);
  const view = new DataView(buf);
  view.setInt32(0, 348, true); // sizeof_hdr
  view.setInt16(40, 3, true); // dim[0] = 3
  view.setInt16(42, 4, true); // dim[1] = 4
  view.setInt16(44, 4, true); // dim[2] = 4
  view.setInt16(46, 4, true); // dim[3] = 4
  view.setInt16(70, 2, true); // datatype = UINT8
  view.setInt16(72, 8, true); // bitpix = 8
  view.setFloat32(76, 1, true); // pixdim[0]
  view.setFloat32(80, 0.5, true); // pixdim[1]
  view.setFloat32(84, 0.5, true); // pixdim[2]
  view.setFloat32(88, 0.5, true); // pixdim[3]
  view.setFloat32(108, 352, true); // vox_offset
  view.setFloat32(112, 1, true); // scl_slope
  view.setInt16(252, 1, true); // qform_code
  view.setInt16(254, 1, true); // sform_code
  view.setFloat32(280, 0.5, true); // srow_x[0]
  view.setFloat32(300, 0.5, true); // srow_y[1]
  view.setFloat32(320, 0.5, true); // srow_z[2]
  // magic = "n+1\0"
  view.setUint8(344, 0x6e);
  view.setUint8(345, 0x2b);
  view.setUint8(346, 0x31);
  view.setUint8(347, 0x00);
  const voxels = new Uint8Array(buf, 352);
  voxels[21] = fillValue;
  voxels[22] = fillValue;
  return Array.from(new Uint8Array(buf));
}

async function injectStage(page, { stage, description, bytes, inputName = 'sub-01_tof.nii.gz' }) {
  await page.evaluate(({ stage: s, description: desc, raw, inputName: name }) => {
    const buf = new Uint8Array(raw).buffer;
    if (!window.app.inputFile) {
      window.app.inputFile = new File([buf.slice(0)], name, { type: 'application/octet-stream' });
    }
    window.app.inferenceExecutor.handleStageData({
      stage: s,
      description: desc,
      niftiData: buf,
    });
  }, { stage, description, raw: bytes, inputName });
}

async function openVesselBoost(page) {
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.app?.inferenceExecutor && window.app?.maskEditor));
}

test('Open in VesselCharter hands off the segmentation via shared handoff and handles unavailable targets', async ({ page }) => {
  const segBytes = makeSyntheticNiftiMask(1);
  await openVesselBoost(page);

  const handoffBtn = page.getByRole('button', { name: 'Open in VesselCharter', exact: true });
  await expect(handoffBtn).toBeHidden();

  // Non-segmentation results keep the VesselCharter button hidden.
  await injectStage(page, { stage: 'n4', description: 'N4 corrected', bytes: segBytes });
  await expect(page.locator('#resultsSection')).not.toHaveClass(/hidden/, { timeout: 30_000 });
  await expect(handoffBtn).toBeHidden();

  // Adding a segmentation reveals and enables the handoff button.
  await injectStage(page, { stage: 'segmentation', description: 'Vessel segmentation', bytes: segBytes });
  await expect(handoffBtn).toBeVisible({ timeout: 30_000 });
  await expect(handoffBtn).toBeEnabled();

  // 1. Standalone server without /vesselcharter/ fails cleanly and re-enables the button.
  await page.context().route('**/vesselcharter/', (route) => route.fulfill({ status: 404 }));
  await handoffBtn.click();
  await expect(page.locator('#statusText')).toContainText('not served beside this app');
  await expect(handoffBtn).toBeEnabled();
  await page.context().unroute('**/vesselcharter/');

  // 2. When /vesselcharter/ is served beside VesselBoost, the real shared takeHandoff receiver
  //    claims the entry, recovers the exact mask bytes, and deletes the entry and secret.
  await page.context().route('**/vesselcharter/', (route) => {
    if (route.request().method() === 'HEAD') {
      return route.fulfill({ status: 200 });
    }
    return route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: `<!doctype html>
<html><body>
<pre id="result"></pre>
<script type="module">
  import { takeHandoff } from '/vendor/webapp-components/src/handoff/index.js';
  const claimed = await takeHandoff();
  const file = claimed?.files?.[0];
  const bytes = file ? Array.from(new Uint8Array(await file.arrayBuffer())) : null;
  document.getElementById('result').textContent = JSON.stringify({
    source: claimed?.source ?? null,
    name: file?.name ?? null,
    type: file?.type ?? null,
    bytes,
  });
</script>
</body></html>`,
    });
  });

  await handoffBtn.click();
  await page.waitForURL(/\/vesselcharter\/$/);
  await expect(page.locator('#result')).not.toBeEmpty();

  const received = JSON.parse(await page.locator('#result').textContent());
  expect(received.source).toEqual({ app: 'vesselboost', title: 'VesselBoost' });
  expect(received.name).toBe('sub-01_tof_vesselboost_segmentation.nii');
  expect(received.type).toBe('application/octet-stream');
  expect(received.bytes).toEqual(segBytes);

  // Confirm IndexedDB entries and sessionStorage secrets were cleaned up by takeHandoff.
  const leftover = await page.evaluate(async () => {
    const secrets = Object.keys(sessionStorage).filter((k) => k.startsWith('neurodesk-handoff:'));
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('neurodesk-handoff');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const entries = await new Promise((resolve, reject) => {
      const req = db.transaction('entries').objectStore('entries').getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return { secrets, entryCount: entries.length };
  });
  expect(leftover).toEqual({ secrets: [], entryCount: 0 });
});

test('Pending VesselCharter handoff cancels cleanly on footer cancel, Clear All, and mask replacement', async ({ page }) => {
  const segV1 = makeSyntheticNiftiMask(1);
  const segV2 = makeSyntheticNiftiMask(2);
  await openVesselBoost(page);

  const handoffBtn = page.getByRole('button', { name: 'Open in VesselCharter', exact: true });
  const cancelBtn = page.locator('#cancelButton');
  const clearBtn = page.locator('#clearResults');

  await injectStage(page, { stage: 'segmentation', description: 'Vessel segmentation', bytes: segV1 });
  await expect(handoffBtn).toBeVisible({ timeout: 30_000 });

  // Hold HEAD probes on demand so we can trigger cancel / clear / mask replacement mid-flight.
  let releaseHead = null;
  let headSeen = null;
  const resetGate = () => {
    let resolveSeen;
    headSeen = new Promise((resolve) => { resolveSeen = resolve; });
    releaseHead = null;
    return () => resolveSeen();
  };
  let notifyHead = resetGate();

  await page.context().route('**/vesselcharter/', async (route) => {
    if (route.request().method() === 'HEAD') {
      notifyHead();
      await new Promise((resolve) => { releaseHead = resolve; });
      await route.fulfill({ status: 200 });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><body>navigated</body></html>' });
  });

  // 1. Footer cancel aborts a pending handoff cleanly and re-enables the button.
  await handoffBtn.click();
  await headSeen;
  await expect(handoffBtn).toBeDisabled();
  await expect(cancelBtn).toBeVisible();
  await cancelBtn.click();
  releaseHead?.();
  await expect(page.locator('#statusText')).toHaveText('Cancelled');
  await expect(cancelBtn).toBeHidden();
  await expect(handoffBtn).toBeEnabled();
  expect(page.url()).not.toContain('/vesselcharter/');

  // 2. Replacing the segmentation during a pending handoff cancels the stale send.
  notifyHead = resetGate();
  await handoffBtn.click();
  await headSeen;
  await injectStage(page, { stage: 'segmentation', description: 'Brain-masked segmentation', bytes: segV2 });
  releaseHead?.();
  await expect(cancelBtn).toBeHidden();
  await expect(handoffBtn).toBeEnabled();
  expect(page.url()).not.toContain('/vesselcharter/');

  // 3. Starting a replacement file import (e.g. slow DICOM conversion) cancels a pending handoff
  //    immediately and keeps the button disabled until import settles.
  notifyHead = resetGate();
  await handoffBtn.click();
  await headSeen;
  await page.evaluate(() => {
    const origHandle = window.app.fileIOController.handleFiles.bind(window.app.fileIOController);
    window.__restoreHandle = origHandle;
    window.app.fileIOController.handleFiles = () => new Promise((resolve) => {
      window.__finishImport = () => {
        window.app.fileIOController.handleFiles = origHandle;
        resolve();
      };
    });
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array([0, 1, 2, 3])], 'replacement.dcm', { type: 'application/dicom' }));
    const input = document.getElementById('fileInput');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  releaseHead?.();
  await expect(cancelBtn).toBeHidden();
  await expect(handoffBtn).toBeDisabled();
  expect(page.url()).not.toContain('/vesselcharter/');
  await page.evaluate(() => window.__finishImport?.());
  await expect(handoffBtn).toBeEnabled();

  // 4. Dropping a replacement DICOM onto #inputDropZone cancels a pending handoff
  //    and keeps the button disabled until convertDropItems settles.
  notifyHead = resetGate();
  await handoffBtn.click();
  await headSeen;
  await page.evaluate(() => {
    const dicom = window.app.fileIOController.dicomController;
    const origConvert = dicom.convertDropItems.bind(dicom);
    dicom.convertDropItems = () => new Promise((resolve) => {
      window.__finishDropImport = () => {
        dicom.convertDropItems = origConvert;
        resolve(null);
      };
    });
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array([0, 1, 2, 3])], 'dropped.dcm', { type: 'application/dicom' }));
    const dropEvent = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt });
    document.getElementById('inputDropZone').dispatchEvent(dropEvent);
  });
  releaseHead?.();
  await expect(cancelBtn).toBeHidden();
  await expect(handoffBtn).toBeDisabled();
  expect(page.url()).not.toContain('/vesselcharter/');
  await page.evaluate(() => window.__finishDropImport?.());
  await expect(handoffBtn).toBeEnabled();

  // 5. Clear All during a pending handoff resets the footer cleanly (no stuck progress/cancel).
  notifyHead = resetGate();
  await handoffBtn.click();
  await headSeen;
  await clearBtn.click();
  releaseHead?.();
  await expect(page.locator('#statusText')).toHaveText('Ready');
  await expect(cancelBtn).toBeHidden();
  await expect(handoffBtn).toBeHidden();
  expect(page.url()).not.toContain('/vesselcharter/');
});

test('Open in VesselCharter disables during mask editing and preserves the edited suffix', async ({ page }) => {
  const segBytes = makeSyntheticNiftiMask(1);
  await openVesselBoost(page);

  const handoffBtn = page.getByRole('button', { name: 'Open in VesselCharter', exact: true });
  await injectStage(page, { stage: 'segmentation', description: 'Vessel segmentation', bytes: segBytes });
  await expect(handoffBtn).toBeVisible({ timeout: 30_000 });

  // Entering mask edit disables Open in VesselCharter; closing re-enables it.
  const editBtn = page.locator('#stageButtons .nd-edit-btn').first();
  const maskEditor = page.locator('nd-mask-editor');
  await expect(editBtn).toBeEnabled();
  await editBtn.click();
  await expect(maskEditor).toBeVisible({ timeout: 15_000 });
  await expect(handoffBtn).toBeDisabled();

  await maskEditor.getByRole('button', { name: 'Cancel' }).click();
  await expect(maskEditor).toBeHidden({ timeout: 15_000 });
  await expect(handoffBtn).toBeEnabled({ timeout: 15_000 });

  // After an edited mask replaces segmentation, the handed-off filename includes _edited.
  const editedBytes = makeSyntheticNiftiMask(3);
  await page.evaluate((raw) => {
    const editedFile = new File([new Uint8Array(raw)], 'segmentation_edited.nii', { type: 'application/octet-stream' });
    const orig = window.app.inferenceExecutor.getResult('segmentation')?.file;
    return window.app.onMaskApplied('segmentation', editedFile, orig);
  }, editedBytes);

  await page.context().route('**/vesselcharter/', (route) => {
    if (route.request().method() === 'HEAD') return route.fulfill({ status: 200 });
    return route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: `<!doctype html><html><body><pre id="name"></pre><script type="module">
        import { takeHandoff } from '/vendor/webapp-components/src/handoff/index.js';
        const claimed = await takeHandoff();
        document.getElementById('name').textContent = claimed?.files?.[0]?.name ?? '';
      </script></body></html>`,
    });
  });

  await handoffBtn.click();
  await page.waitForURL(/\/vesselcharter\/$/);
  await expect(page.locator('#name')).toHaveText('sub-01_tof_vesselboost_segmentation_edited.nii');
});
