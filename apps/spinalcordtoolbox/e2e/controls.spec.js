import { expect, test } from '@playwright/test';

// Checks that need a real layout engine and the real stylesheets; the control
// wiring itself is exercised in scripts/test_ui_controls.mjs.

test('the workspace opens with processing locked and the shell dialogs working', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => Boolean(globalThis.app?.automation));

  // No start page: the sidebar, viewer and status footer are on screen.
  await expect(page.locator('#inputDropZone')).toBeVisible();
  await expect(page.locator('#gl1, #fallbackCanvas2d').first()).toBeAttached();
  await expect(page.locator('footer#status #statusText')).toHaveText('Ready');
  await expect(page.locator('#cancelButton')).toBeHidden();

  // Nothing can be run before an input is loaded.
  await expect(page.locator('#runSegmentation')).toBeDisabled();
  await expect(page.locator('#runProcessingBtn')).toBeDisabled();

  // A hidden fallback message must not paint over a working canvas: the
  // stylesheet's display rule for the message must not beat [hidden].
  const hiddenDisplay = await page.evaluate(() => {
    const message = document.getElementById('viewerUnavailableMessage');
    const wasHidden = message.hidden;
    message.hidden = true;
    const display = getComputedStyle(message).display;
    message.hidden = wasHidden;
    return display;
  });
  expect(hiddenDisplay).toBe('none');

  // About, Cite and Privacy fade a dialog in over the workspace and out again.
  // The overlay is always in the layout; closed means transparent and inert.
  for (const [open, close, modal] of [
    ['#aboutButton', '#closeAbout', '#aboutModal'],
    ['#citationsButton', '#closeCitations', '#citationsModal'],
    ['#privacyButton', '#closePrivacy', '#privacyModal']
  ]) {
    await expect(page.locator(modal)).toHaveCSS('opacity', '0');
    await expect(page.locator(modal)).toHaveCSS('pointer-events', 'none');
    await page.locator(open).click();
    await expect(page.locator(modal)).toHaveCSS('opacity', '1');
    await expect(page.locator(modal)).toHaveCSS('pointer-events', 'auto');
    await page.locator(close).click();
    await expect(page.locator(modal)).toHaveCSS('opacity', '0');
    await expect(page.locator(modal)).toHaveCSS('pointer-events', 'none');
  }

  // The technical log starts collapsed and expands from its header.
  await expect(page.locator('#consoleOutput')).toBeHidden();
  await page.locator('#spinalcordtoolbox-log [data-disclosure-toggle]').click();
  await expect(page.locator('#consoleOutput')).toBeVisible();
});
