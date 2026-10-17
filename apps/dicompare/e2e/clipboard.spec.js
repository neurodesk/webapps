import { test, expect } from '@playwright/test';

for (const width of [1280, 390]) {
  test(`clipboard success, fallback and failure reach each caller at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    const errors = [];
    page.on('pageerror', error => errors.push(error.stack || error.message));
    await page.context().route('**/cloudflareinsights.com/**', route => route.fulfill({ status: 204 }));
    await page.goto('./');
    await expect(page.locator('#statusText')).toContainText('Ready', { timeout: 180000 });
    await page.getByRole('button', { name: 'From data', exact: true }).click();
    await page.getByRole('button', { name: 'Library', exact: true }).click();
    await page.getByRole('checkbox', { name: 'Group schemas', exact: true }).check();
    await expect(page.getByTitle('Copy schema link', { exact: true }).first()).toBeVisible();

    async function configureClipboard(mode) {
      await page.evaluate(mode => {
        window.copyAttempts = [];
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
          writeText: async text => {
            window.copyAttempts.push({ method: 'clipboard', text });
            if (mode !== 'success') throw new Error('Clipboard permission denied');
          },
        } });
        document.execCommand = command => {
          window.copyAttempts.push({ method: command, text: document.querySelector('textarea')?.value });
          return mode === 'fallback';
        };
      }, mode);
    }

    async function exercise(button, context, successName) {
      for (const mode of ['success', 'fallback', 'failure']) {
        await configureClipboard(mode);
        await button.click();
        if (mode === 'failure') {
          await expect(page.locator('#statusText')).toContainText(context);
          await expect(page.locator('#technicalLogOutput')).toContainText(`${context}: Could not copy to clipboard`);
          await expect(page.getByRole('button', { name: successName, exact: true })).toHaveCount(0);
          await page.screenshot({ path: testInfo.outputPath(`clipboard-${width}-${context.replaceAll(' ', '-')}.png`), fullPage: true });
        } else {
          const feedback = page.getByRole('button', { name: successName, exact: true });
          await expect(feedback).toBeVisible();
          await expect(feedback).toHaveCount(0, { timeout: 5000 });
        }
        const attempts = await page.evaluate(() => window.copyAttempts);
        expect(attempts.map(attempt => attempt.method)).toEqual(mode === 'success' ? ['clipboard'] : ['clipboard', 'copy']);
        expect(attempts[0].text.length).toBeGreaterThan(0);
        if (mode !== 'success') expect(attempts[1].text).toBe(attempts[0].text);
        await expect(page.locator('textarea')).toHaveCount(0);
      }
    }

    await exercise(page.getByTitle('Copy schema link', { exact: true }).first(), 'Copy schema link failed', 'Copied!');
    await page.keyboard.press('Escape');
    await page.locator('#status').scrollIntoViewIfNeeded();
    await expect(page.locator('#statusText')).toContainText('Copy schema link failed');
    await page.goto('./schema');
    await page.getByPlaceholder('Search schemas, acquisitions, tags...').fill('ASL');
    await page.getByRole('checkbox', { name: 'Group schemas', exact: true }).check();
    await page.getByTitle('Open schema', { exact: true }).first().click();
    await page.waitForURL('**/schema/ASL_Clinical_Guidelines_v1.0');
    await exercise(page.getByRole('button', { name: 'Copy DOI', exact: true }), 'Copy DOI failed', 'Copied!');
    const statusBounds = await page.locator('#status').boundingBox();
    expect(statusBounds.y).toBeGreaterThanOrEqual(0);
    expect(statusBounds.y + statusBounds.height).toBeLessThanOrEqual(844);
    await page.getByTitle('Cite dicompare', { exact: true }).evaluate(button => button.click());
    const citation = page.getByRole('dialog');
    await exercise(citation.getByRole('button', { name: 'Copy', exact: true }).first(), 'Copy failed', 'Copied');
    await exercise(citation.getByRole('button', { name: 'Copy', exact: true }).nth(1), 'Copy with feedback failed', 'Copied');
    expect(errors).toEqual([]);
  });
}
