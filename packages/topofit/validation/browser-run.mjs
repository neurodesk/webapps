// Drive the production TopoFit app and retain the exact files offered to users.
import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';

const [url, input, outputDirectory, conformOption] = process.argv.slice(2);
if (!outputDirectory) {
  throw new Error('Usage: browser-run.mjs URL input.nii.gz output-directory');
}

await mkdir(outputDirectory, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1440, height: 1000 },
  acceptDownloads: true,
});
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));

try {
  await page.goto(url);
  await expect.poll(() => page.evaluate(() => crossOriginIsolated)).toBe(true);
  await page.locator('#imageInput').setInputFiles(input);
  await expect(page.locator('#runButton')).toBeEnabled();
  if (conformOption === '--no-conform') await page.locator('#conform').uncheck();
  await page.locator('#advancedSettings > summary').click();
  await page.locator('#thickness').selectOption('0');
  await page.screenshot({ path: `${outputDirectory}/desktop-input.png`, fullPage: true });

  const started = Date.now();
  await page.locator('#runButton').click();
  let previousStatus = '';
  for (;;) {
    const currentStatus = await page.locator('#statusText').textContent();
    if (currentStatus !== previousStatus) {
      console.log(currentStatus);
      previousStatus = currentStatus;
    }
    if (currentStatus?.includes('Surfaces ready')) break;
    if (await page.locator('#cancelButton').isHidden()) {
      throw new Error(`Processing stopped: ${currentStatus}`);
    }
    if (Date.now() - started > 30 * 60 * 1000) {
      throw new Error('Full TopoFit reconstruction exceeded 30 minutes.');
    }
    await page.waitForTimeout(1000);
  }

  await expect(page.locator('#outputSection')).toHaveAttribute('open', '');
  await expect(page.locator('#viewerError')).toBeHidden();
  await page.screenshot({ path: `${outputDirectory}/desktop-result.png`, fullPage: true });
  const rows = page.locator('#resultList .nd-volume-toggle');
  for (let index = 0; index < await rows.count(); index += 1) {
    const pending = page.waitForEvent('download');
    await rows.nth(index).locator('.nd-download-btn').click();
    const download = await pending;
    await download.saveAs(`${outputDirectory}/${download.suggestedFilename()}`);
  }
  await writeFile(
    `${outputDirectory}/browser-run.json`,
    `${JSON.stringify({
      seconds: (Date.now() - started) / 1000,
      browser: browser.version(),
      crossOriginIsolated: await page.evaluate(() => crossOriginIsolated),
      pageErrors,
      finalStatus: previousStatus,
    }, null, 2)}\n`,
  );
  if (pageErrors.length) throw new Error(pageErrors.join('\n'));
  console.log(`Browser result downloaded to ${outputDirectory}`);
} finally {
  await browser.close();
}
