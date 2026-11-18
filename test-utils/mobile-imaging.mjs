import { expect } from '@playwright/test';

function createTestNiftiBuffer() {
  // A NIfTI-1 header followed by a 16×16×16 uint8 volume.
  const buffer = Buffer.alloc(352 + 4096);
  buffer.writeInt32LE(348, 0);
  [3, 16, 16, 16, 1, 1, 1, 1].forEach((value, index) => buffer.writeInt16LE(value, 40 + index * 2));
  buffer.writeInt16LE(2, 70);
  buffer.writeInt16LE(8, 72);
  for (let index = 0; index < 8; index++) buffer.writeFloatLE(1, 76 + index * 4);
  buffer.writeFloatLE(352, 108);
  buffer.writeFloatLE(1, 112);
  buffer.write('n+1\0', 344);
  for (let index = 352; index < buffer.length; index++) buffer[index] = index % 251;
  return buffer;
}

export async function verifyMobileImageImport(page) {
  await page.setViewportSize({ width: 320, height: 568 });
  const buffer = createTestNiftiBuffer();
  const name = 'mobile-check-a-long-image-filename-with-many-details-and-no-spaces.nii';
  await page.locator('#fileInput').setInputFiles({ name, mimeType: 'application/octet-stream', buffer });
  await expect(page.locator('#fileList')).toContainText(name);
  await page.locator('#gl1').scrollIntoViewIfNeeded();
  const bounds = await page.locator('#gl1').boundingBox();
  expect(bounds.width).toBe(320);
  expect(bounds.height).toBeGreaterThanOrEqual(300);
}

export async function verifyMobileMeasurement(page, origin) {
  await page.setViewportSize({ width: 390, height: 844 });
  const attributes = {
    multiscales: [{
      axes: ['z', 'y', 'x'].map(name => ({ name, unit: 'millimeter' })),
      datasets: [{ path: '0', coordinateTransformations: [{ type: 'scale', scale: [1, 1, 1] }] }],
    }],
  };
  const array = {
    zarr_format: 2,
    shape: [16, 16, 16],
    chunks: [16, 16, 16],
    dtype: '|u1',
    compressor: null,
    fill_value: 0,
    order: 'C',
    filters: null,
  };
  const metadata = {
    '.zgroup': { zarr_format: 2 },
    '.zattrs': attributes,
    '0/.zarray': array,
    '0/.zattrs': {},
  };
  await page.context().route('**/mobile-fixture/**', route => {
    const path = new URL(route.request().url()).pathname.split('/mobile-fixture/')[1];
    if (path === '.zmetadata') return route.fulfill({ json: { zarr_consolidated_format: 1, metadata } });
    if (path in metadata) return route.fulfill({ json: metadata[path] });
    if (path === '0/0.0.0') {
      return route.fulfill({
        contentType: 'application/octet-stream',
        body: Buffer.from(Array.from({ length: 4096 }, (_, index) => index % 251)),
      });
    }
    return route.fulfill({ status: 404, body: '' });
  });
  await page.goto(`${origin}/zarro/?source=custom&url=${encodeURIComponent(origin + '/mobile-fixture/')}&layout=34`);
  await expect(page.locator('#interactionTool')).toBeEnabled({ timeout: 20000 });
  await page.locator('#toolsPanel > summary').tap();
  await page.locator('#interactionTool').tap();
  const canvas = page.locator('.nvslide-pane-main canvas');
  await canvas.scrollIntoViewIfNeeded();
  await expect(canvas).toBeVisible();
  const rect = await canvas.boundingBox();
  const session = await page.context().newCDPSession(page);
  const x = rect.x + rect.width / 2;
  const y = rect.y + rect.height / 2;
  // Native touch input catches browser gesture cancellation; dispatchEvent cannot.
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  for (let index = 1; index <= 6; index++) {
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchMove', touchPoints: [{ x: x + index * 5, y: y + index * 5 }],
    });
  }
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(page.locator('#clearMeasurements')).toBeEnabled({ timeout: 5000 });
  await expect(page.locator('#measurementStatus')).toContainText('mm');
}

export async function verifyMobileMemoryCrash(page, origin) {
  await page.setViewportSize({ width: 320, height: 568 });
  const buffer = createTestNiftiBuffer();
  const niftiInput = { name: 'mobile-crash-check.nii', mimeType: 'application/octet-stream', buffer };
  const browserCdp = await page.context().browser().newBrowserCDPSession();
  const crashPage = await page.context().newPage();
  await crashPage.setViewportSize({ width: 320, height: 568 });
  let crashTargetId = null;
  try {
    await crashPage.goto(`${origin}/musclemap/?crashProbe=1`, { waitUntil: 'domcontentloaded' });
    await expect(crashPage.locator('.nd-app-bar:visible').first()).toBeVisible();

    // 1. Load real NIfTI data so a live session checkpoint exists, then perform a
    //    normal user reload and confirm pagehide clears the checkpoint cleanly.
    await crashPage.locator('#fileInput').setInputFiles(niftiInput);
    await expect(crashPage.locator('#runSegmentation')).toBeEnabled();
    await expect.poll(() => crashPage.evaluate(() => {
      const raw = window.sessionStorage.getItem('neurodesk-memory-guard:/musclemap/');
      return raw ? JSON.parse(raw).loaded === true : false;
    })).toBe(true);
    await crashPage.reload({ waitUntil: 'domcontentloaded' });
    await expect(crashPage.locator('#statusText')).toHaveText('Drag and drop files');
    await expect(crashPage.locator('#statusText')).not.toHaveClass(/\berror\b/);

    // 2. Drive the real workflow again (load NIfTI + click #runSegmentation), wait for
    //    MuscleMap's own Cancel control and past the 250 ms click bridge so the app's
    //    live running state owns the checkpoint, then force-crash the Chromium renderer
    //    mid-run via CDP Page.crash and revive the EXACT same tab target.
    await crashPage.locator('#fileInput').setInputFiles(niftiInput);
    await expect(crashPage.locator('#runSegmentation')).toBeEnabled();
    await crashPage.locator('#runSegmentation').click();
    await expect(crashPage.locator('#cancelButton')).toBeVisible();
    await crashPage.waitForTimeout(300);
    await expect.poll(() => crashPage.evaluate(() => {
      const raw = window.sessionStorage.getItem('neurodesk-memory-guard:/musclemap/');
      return raw ? JSON.parse(raw).active === true : false;
    })).toBe(true);

    const { targetInfos } = await browserCdp.send('Target.getTargets');
    crashTargetId = targetInfos.find((info) => info.type === 'page' && info.url.includes('crashProbe=1'))?.targetId;
    expect(crashTargetId).toBeTruthy();

    const pageCdp = await crashPage.context().newCDPSession(crashPage);
    const crashed = crashPage.waitForEvent('crash', { timeout: 10000 });
    void pageCdp.send('Page.crash').catch(() => {});
    await crashed;

    const { sessionId } = await browserCdp.send('Target.attachToTarget', { targetId: crashTargetId, flatten: false });
    let nextCdpId = 1;
    const sendToRevivedTab = (method, params = {}, timeoutMs = 10000) => new Promise((resolve, reject) => {
      const id = nextCdpId++;
      const timer = setTimeout(() => {
        browserCdp.off('Target.receivedMessageFromTarget', onMessage);
        reject(new Error(`Timed out waiting for CDP ${method} on revived tab`));
      }, timeoutMs);
      function onMessage({ sessionId: incomingSessionId, message }) {
        if (incomingSessionId !== sessionId) return;
        const parsed = JSON.parse(message);
        if (parsed.id !== id) return;
        clearTimeout(timer);
        browserCdp.off('Target.receivedMessageFromTarget', onMessage);
        if (parsed.error) reject(new Error(parsed.error.message));
        else resolve(parsed.result);
      }
      browserCdp.on('Target.receivedMessageFromTarget', onMessage);
      browserCdp.send('Target.sendMessageToTarget', {
        sessionId,
        message: JSON.stringify({ id, method, params }),
      }).catch((error) => {
        clearTimeout(timer);
        browserCdp.off('Target.receivedMessageFromTarget', onMessage);
        reject(error);
      });
    });

    await sendToRevivedTab('Page.navigate', { url: `${origin}/musclemap/` });
    await expect.poll(async () => {
      const response = await sendToRevivedTab('Runtime.evaluate', {
        expression: `JSON.stringify({
          ready: document.readyState,
          status: document.getElementById('statusText')?.textContent?.trim() || '',
          hasErrorClass: Boolean(document.getElementById('statusText')?.classList.contains('error')),
          consoleText: document.querySelector('#consoleOutput, .nd-console-output, .console-output')?.textContent || '',
          copyText: document.getElementById('consoleOutput')?.[Symbol.for('neurodesk.consoleOutput')]?.getText?.() || '',
          fitsWidth: document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
          statusInView: (() => {
            const rect = document.getElementById('statusText')?.getBoundingClientRect();
            return Boolean(rect && rect.top >= 0 && rect.bottom <= window.innerHeight);
          })()
        })`,
        returnByValue: true,
      }).catch(() => null);
      return response?.result?.value ? JSON.parse(response.result.value) : null;
    }, { timeout: 10000 }).toEqual(expect.objectContaining({
      status: expect.stringContaining('reloaded mid-run (likely low memory)'),
      hasErrorClass: true,
      consoleText: expect.stringContaining('reloaded before processing finished'),
      copyText: expect.stringContaining('reloaded before processing finished'),
      fitsWidth: true,
      statusInView: true,
    }));

    // 3. An idle hidden tab checkpoint without document.wasDiscarded never claims a crash,
    //    and an in-page allocation failure translates into concise phone guidance.
    const checkPage = await page.context().newPage();
    await checkPage.setViewportSize({ width: 320, height: 568 });
    try {
      await checkPage.addInitScript(() => {
        if (window.sessionStorage.getItem('idle-seeded')) return;
        window.sessionStorage.setItem('idle-seeded', '1');
        window.sessionStorage.setItem('neurodesk-memory-guard:/musclemap/', JSON.stringify({
          active: false,
          loaded: true,
          hidden: true,
          detail: '',
          updatedAt: Date.now(),
        }));
      });
      await checkPage.goto(`${origin}/musclemap/`, { waitUntil: 'domcontentloaded' });
      await expect(checkPage.locator('#statusText')).toHaveText('Drag and drop files');
      await expect(checkPage.locator('#statusText')).not.toHaveClass(/\berror\b/);

      await checkPage.evaluate(() => {
        const event = new Event('unhandledrejection');
        event.reason = new RangeError('Array buffer allocation failed');
        window.dispatchEvent(event);
      });
      await expect(checkPage.locator('#statusText')).toContainText('Out of browser memory on this device');
      await expect(checkPage.locator('#statusText')).toHaveClass(/\berror\b/);
      expect(await checkPage.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
    } finally {
      await checkPage.close();
    }
  } finally {
    if (crashTargetId) await browserCdp.send('Target.closeTarget', { targetId: crashTargetId }).catch(() => {});
    await crashPage.close().catch(() => {});
    await browserCdp.detach().catch(() => {});
  }
}
