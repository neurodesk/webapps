import { test as base } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';

export { expect } from '@playwright/test';

export const test = base.extend({
  seedsegDiagnostics: [async ({ page }, use, testInfo) => {
    const errors = [];
    const pageError = error => {
      const message = `[seedseg-page-error] ${error.stack ?? error.message}`;
      errors.push(message);
      console.error(message);
    };
    const browserError = message => {
      if (message.type() !== 'error') return;
      const text = `[seedseg-browser-error] ${message.text()}`;
      errors.push(text);
      console.error(text);
    };
    page.on('pageerror', pageError);
    page.on('console', browserError);
    try {
      await use();
    } finally {
      page.off('pageerror', pageError);
      page.off('console', browserError);
      if (testInfo.status !== testInfo.expectedStatus) {
        const log = await page.locator('#consoleOutput').textContent({ timeout: 5000 })
          .catch(error => `Technical log unavailable: ${error.message}`);
        const text = [...errors, 'SeedSeg technical log:', log ?? ''].join('\n');
        const path = testInfo.outputPath('seedseg-technical-log.txt');
        await mkdir(testInfo.outputDir, { recursive: true });
        await writeFile(path, text);
        await testInfo.attach('seedseg-technical-log', { path, contentType: 'text/plain' });
        console.log(`SeedSeg diagnostics after ${testInfo.title}:\n${text}`);
      }
    }
  }, { auto: true }],
});
