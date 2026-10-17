import { test, expect } from '@playwright/test';

for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
  for (const view of ['catalog', 'schema']) {
    test(`schema console pointer controls remain reachable in ${view} at ${viewport.width}px`, async ({ page }, testInfo) => {
      await page.setViewportSize(viewport);
      const errors = [];
      const pythonRequests = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('request', request => {
        if (/pyodide|dicompare-worker/.test(request.url())) pythonRequests.push(request.url());
      });
      await page.context().route('**/cloudflareinsights.com/**', route => route.fulfill({ status: 204 }));
      await page.goto('./schema');
      await page.getByPlaceholder('Search schemas, acquisitions, tags...').fill('ASL');
      await page.getByRole('checkbox', { name: 'Group schemas', exact: true }).check();
      if (view === 'schema') {
        await page.getByTitle('Open schema', { exact: true }).first().click();
        await page.waitForURL('**/schema/ASL_Clinical_Guidelines_v1.0');
      }
      const log = page.locator('#technicalLog');
      const toggle = log.getByRole('button', { name: 'Technical log', exact: true });
      const copy = page.locator('#technicalLogCopy');
      const clear = page.locator('#technicalLogClear');
      const output = page.locator('#technicalLogOutput');
      const footer = page.locator('#status');
      await expect(page.locator('#statusText')).toHaveText('Ready');
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');

      async function reopen() {
        await toggle.click({ timeout: 3000 });
        await expect(toggle).toHaveAttribute('aria-expanded', 'true');
        await toggle.click({ timeout: 3000 });
        await expect(toggle).toHaveAttribute('aria-expanded', 'false');
        await toggle.click({ timeout: 3000 });
        await expect(toggle).toHaveAttribute('aria-expanded', 'true');
      }

      async function configureClipboard(failure) {
        await page.evaluate(failure => {
          window.consoleCopies = [];
          Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
            writeText: async text => {
              if (failure) throw new Error('Clipboard permission denied');
              window.consoleCopies.push(text);
            },
          } });
          document.execCommand = () => {
            throw new Error('Clipboard access was refused. Check browser permissions before trying to copy this schema again. '.repeat(3));
          };
        }, failure);
      }

      async function recordLayout(state) {
        const bounds = await footer.boundingBox();
        expect(bounds.y).toBeGreaterThanOrEqual(0);
        expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);
        const header = await log.locator('.nd-console-header').boundingBox();
        expect(header.y + header.height).toBeLessThanOrEqual(bounds.y);
        await testInfo.attach(`${state}-geometry`, { body: JSON.stringify({ footer: bounds, header }), contentType: 'application/json' });
        for (const theme of ['light', 'dark']) {
          await page.evaluate(theme => {
            document.documentElement.dataset.neurodeskTheme = theme;
            document.documentElement.classList.toggle('dark', theme === 'dark');
          }, theme);
          await page.screenshot({ path: testInfo.outputPath(`${state}-${theme}.png`) });
        }
        return bounds.height;
      }

      await reopen();
      await configureClipboard(false);
      await copy.click({ timeout: 3000 });
      await expect(copy).toHaveText('Copied');
      await clear.click({ timeout: 3000 });
      await expect(output).toHaveText('');
      const readyHeight = await recordLayout('ready');
      await toggle.click();

      const action = view === 'catalog'
        ? page.getByTitle('Copy schema link', { exact: true }).first()
        : page.getByRole('button', { name: 'Copy DOI', exact: true });
      await configureClipboard(false);
      await action.click();
      await expect(action).toHaveText('Copied!');
      await expect(action).not.toHaveText('Copied!', { timeout: 5000 });
      await configureClipboard(true);
      await action.click();
      await expect(page.locator('#statusText')).toContainText('Clipboard access was refused');
      await expect(output).toContainText('Clipboard access was refused');
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');
      await toggle.click();
      await reopen();
      const errorHeight = await recordLayout('multiline-error');
      expect(errorHeight).toBeGreaterThan(readyHeight);
      await configureClipboard(false);
      await copy.click({ timeout: 3000 });
      await expect(copy).toHaveText('Copied');
      expect((await page.evaluate(() => window.consoleCopies)).at(-1)).toContain('Clipboard access was refused');
      await clear.click({ timeout: 3000 });
      await expect(output).toHaveText('');
      await expect(page.locator('#statusText')).toHaveText('Ready');
      await toggle.click();
      await reopen();
      await recordLayout('cleared');
      expect(errors).toEqual([]);
      expect(pythonRequests).toEqual([]);
    });
  }
}
