import { test, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dicomSeries } from '../../../test-utils/dicom-fixture.mjs';

test.use({ isMobile: true, hasTouch: true });

for (const width of [320, 390]) {
  test(`populated reference and test-data actions remain separate at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    await page.context().route('**/cloudflareinsights.com/**', route => route.fulfill({ status: 204 }));
    const folders = [];
    for (const series of [42, 43]) {
      const folder = testInfo.outputPath(`series-${series}`);
      await mkdir(folder, { recursive: true });
      for (const file of dicomSeries({ series })) await writeFile(join(folder, file.name), file.buffer);
      folders.push(folder);
    }
    await page.goto('./');
    await page.getByRole('button', { name: 'From data', exact: true }).click();
    await page.locator('#staged-load-schema').setInputFiles(folders[0]);
    const attach = page.locator('input[id^="load-data-"]');
    await expect(attach).toHaveCount(1, { timeout: 180000 });
    await attach.setInputFiles(folders[1]);
    await expect(page.getByTitle('View test data images')).toBeVisible({ timeout: 180000 });
    const headings = page.locator('.uppercase').filter({ hasText: /^(Reference|Test data)$/ });
    await expect(headings).toHaveCount(2);
    const layout = await headings.evaluateAll(nodes => nodes.map(node => {
      const rect = element => {
        const bounds = element.getBoundingClientRect();
        return { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom };
      };
      return { heading: rect(node), buttons: [...node.parentElement.querySelectorAll('button')].map(rect) };
    }));
    for (const { heading, buttons } of layout) {
      for (const bounds of [heading, ...buttons]) {
        expect(bounds.left).toBeGreaterThanOrEqual(0);
        expect(bounds.right).toBeLessThanOrEqual(width);
      }
      const controls = [heading, ...buttons];
      for (let first = 0; first < controls.length; first++) {
        for (const second of controls.slice(first + 1)) {
          const overlapX = Math.min(controls[first].right, second.right) - Math.max(controls[first].left, second.left);
          const overlapY = Math.min(controls[first].bottom, second.bottom) - Math.max(controls[first].top, second.top);
          expect(overlapX > 0 && overlapY > 0).toBe(false);
        }
      }
    }
    expect(layout[1].heading.top).toBeGreaterThan(layout[0].heading.bottom);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.screenshot({ path: testInfo.outputPath(`comparison-${width}.png`), fullPage: true });
  });
}
