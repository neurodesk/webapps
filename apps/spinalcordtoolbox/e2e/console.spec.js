import { expect, test } from '@playwright/test';

// The console below the viewer: hide and show, enlarge, and an analysis log beside the technical log.

const height = (locator) => locator.evaluate((node) => node.getBoundingClientRect().height);

async function openApp(page) {
  await page.goto('/');
  await page.waitForFunction(() => window.app?.log?.channels?.length === 2);
  // The viewer mounts without blocking input; measure heights only after its layout settles.
  await page.waitForFunction(() => window.app?.viewerMount);
  await page.evaluate(() => window.app.viewerMount.ready);
  return {
    log: page.locator('#spinalcordtoolbox-log'),
    toggle: page.locator('#spinalcordtoolbox-log [data-disclosure-toggle]'),
    panel: page.locator('#spinalcordtoolbox-log [data-disclosure-panel]'),
    handle: page.locator('#spinalcordtoolbox-log .nd-console-resizer'),
    analysisTab: page.getByRole('tab', { name: 'Analysis' }),
    technicalTab: page.getByRole('tab', { name: 'Technical' }),
    analysis: page.locator('#spinalcordtoolbox-logOutput-analysis'),
    technical: page.locator('#spinalcordtoolbox-logOutput-technical'),
    canvas: page.locator('.viewer-canvas-wrapper'),
  };
}

async function writeBoth(page) {
  await page.evaluate(() => {
    window.app.logAnalysis('Task: Spinal cord on t2.nii.gz');
    window.app.logAnalysis('segmentation: 2400 voxels (1505.3 mm^3)');
    window.app.updateOutput('Session created. Input: input, Output: output');
  });
}

test('console hides and shows by mouse and keyboard, keeps entries and frees space for the viewer', async ({ page }, testInfo) => {
  const ui = await openApp(page);
  await expect(ui.log).toHaveClass(/collapsed/);
  await expect(ui.toggle).toHaveText('Log');
  await expect(ui.toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(ui.panel).toBeHidden();
  await writeBoth(page);
  await expect(ui.log).toHaveClass(/collapsed/);
  const collapsedCanvas = await height(ui.canvas);
  const collapsedLog = await height(ui.log);
  await page.screenshot({ path: testInfo.outputPath('console-collapsed.png') });

  // Mouse.
  await ui.toggle.click();
  await expect(ui.toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(ui.analysis).toBeVisible();
  await expect(ui.analysis).toContainText('Task: Spinal cord on t2.nii.gz');
  const openLog = await height(ui.log);
  expect(openLog).toBe(120);
  expect(await height(ui.canvas)).toBeCloseTo(collapsedCanvas - (openLog - collapsedLog), 0);
  await page.screenshot({ path: testInfo.outputPath('console-open.png') });
  await ui.toggle.click();
  await expect(ui.panel).toBeHidden();
  expect(await height(ui.canvas)).toBeCloseTo(collapsedCanvas, 0);

  // Keyboard.
  await ui.toggle.focus();
  await page.keyboard.press('Enter');
  await expect(ui.toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(ui.analysis).toContainText('segmentation: 2400 voxels (1505.3 mm^3)');
  await page.keyboard.press('Space');
  await expect(ui.toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(ui.panel).toBeHidden();
  expect(await height(ui.canvas)).toBeCloseTo(collapsedCanvas, 0);

  // Entries of both logs are still there after collapsing and reopening.
  await page.keyboard.press('Enter');
  await expect(ui.analysis.locator('.nd-console-line')).toHaveCount(2);
  await ui.technicalTab.click();
  await expect(ui.technical).toContainText('Session created. Input: input, Output: output');
});

test('analysis and technical logs are separate, each with working Copy and Clear', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const ui = await openApp(page);
  await writeBoth(page);

  // Choosing a tab opens the collapsed console on that log.
  await ui.technicalTab.click();
  await expect(ui.log).not.toHaveClass(/collapsed/);
  await expect(ui.technicalTab).toHaveAttribute('aria-selected', 'true');
  await expect(ui.technical).toBeVisible();
  await expect(ui.analysis).toBeHidden();
  await expect(ui.technical).toContainText('Session created');
  await expect(ui.technical).not.toContainText('Task: Spinal cord');
  await expect(ui.analysis).not.toContainText('Session created');

  await page.locator('#spinalcordtoolbox-logCopy').click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('Session created');
  expect(await page.evaluate(() => navigator.clipboard.readText())).not.toContain('Task: Spinal cord');

  // Arrow keys move between the tabs.
  await ui.technicalTab.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(ui.analysisTab).toBeFocused();
  await expect(ui.analysis).toBeVisible();
  await page.locator('#spinalcordtoolbox-logCopy').click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('segmentation: 2400 voxels');

  await page.locator('#spinalcordtoolbox-logClear').click();
  await expect(ui.analysis.locator('.nd-console-line')).toHaveCount(0);
  await ui.technicalTab.click();
  await expect(ui.technical).toContainText('Session created');
  await page.locator('#spinalcordtoolbox-logClear').click();
  await expect(ui.technical.locator('.nd-console-line')).toHaveCount(0);

  // A failed run opens the console on the analysis log; status stays in the footer.
  await ui.toggle.click();
  await expect(ui.log).toHaveClass(/collapsed/);
  await page.evaluate(() => window.app.inferenceExecutor.updateOutput('Error: Model download failed'));
  await expect(ui.log).not.toHaveClass(/collapsed/);
  await expect(ui.analysisTab).toHaveAttribute('aria-selected', 'true');
  await expect(ui.analysis.locator('.nd-console-error')).toHaveText(/Error: Model download failed/);
  await expect(page.locator('footer#status #statusText[role="status"]')).toHaveCount(1);
  await expect(page.locator('#spinalcordtoolbox-log :is(progress, [role="status"])')).toHaveCount(0);
});

test('console is enlarged by dragging or from the keyboard and the viewer keeps the rest', async ({ page }, testInfo) => {
  const ui = await openApp(page);
  await writeBoth(page);
  await expect(ui.handle).toBeHidden();
  await ui.toggle.click();
  await expect(ui.handle).toBeVisible();
  const canvasBefore = await height(ui.canvas);

  // Drag the separator up by 150px.
  const box = await ui.handle.boundingBox();
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y - 80, { steps: 4 });
  await page.mouse.move(x, y - 150, { steps: 4 });
  await page.mouse.up();
  expect(await height(ui.log)).toBe(270);
  expect(await height(ui.canvas)).toBeCloseTo(canvasBefore - 150, 0);
  await page.screenshot({ path: testInfo.outputPath('console-enlarged.png') });

  // Collapse and reopen: the size and the entries are kept.
  await ui.toggle.click();
  await expect(ui.panel).toBeHidden();
  expect(await height(ui.log)).toBeLessThan(60);
  await ui.toggle.click();
  expect(await height(ui.log)).toBe(270);
  await expect(ui.analysis.locator('.nd-console-line')).toHaveCount(2);

  // Keyboard: arrows step, End stops while the viewer still has 160px, Home restores the default.
  await ui.handle.focus();
  await page.keyboard.press('ArrowUp');
  expect(await height(ui.log)).toBe(294);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  expect(await height(ui.log)).toBe(246);
  await page.keyboard.press('End');
  expect(await height(ui.canvas)).toBeGreaterThanOrEqual(159);
  expect(await height(ui.canvas)).toBeLessThanOrEqual(161);
  expect(await height(ui.log)).toBeGreaterThan(270);
  await expect(ui.handle).toHaveAttribute('aria-valuenow', String(await height(ui.log)));
  await page.screenshot({ path: testInfo.outputPath('console-maximum.png') });
  await page.keyboard.press('ArrowUp');
  expect(await height(ui.canvas)).toBeGreaterThanOrEqual(159);
  await page.keyboard.press('Home');
  expect(await height(ui.log)).toBe(120);
  expect(await height(ui.canvas)).toBeCloseTo(canvasBefore, 0);
});

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('console opens, switches logs and resizes at phone width', async ({ page }, testInfo) => {
    const ui = await openApp(page);
    await writeBoth(page);
    await ui.toggle.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('phone-console-collapsed.png') });
    for (const control of [ui.toggle, ui.analysisTab, ui.technicalTab, page.locator('#spinalcordtoolbox-logCopy'), page.locator('#spinalcordtoolbox-logClear')]) {
      const box = await control.boundingBox();
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.width).toBeGreaterThanOrEqual(44);
    }
    // Toggle, tabs, Copy and Clear share one row; the tabs sit beside the toggle, inside the phone width.
    const clear = await page.locator('#spinalcordtoolbox-logClear').boundingBox();
    const toggle = await ui.toggle.boundingBox();
    const lastTab = await ui.technicalTab.boundingBox();
    expect(Math.abs(clear.y - toggle.y)).toBeLessThan(2);
    expect(lastTab.x + lastTab.width - toggle.x).toBeLessThanOrEqual(390);

    await ui.technicalTab.tap();
    await expect(ui.technical).toBeVisible();
    await expect(ui.technical).toContainText('Session created');
    await ui.analysisTab.tap();
    await expect(ui.analysis).toContainText('Task: Spinal cord on t2.nii.gz');
    await page.screenshot({ path: testInfo.outputPath('phone-console-open.png') });

    const handle = await ui.handle.boundingBox();
    expect(handle.height).toBeGreaterThanOrEqual(44);
    const before = await height(ui.log);
    const canvasBefore = await height(ui.canvas);
    await ui.handle.focus();
    await page.keyboard.press('End');
    const after = await height(ui.log);
    const canvasAfter = await height(ui.canvas);
    expect(after).toBeGreaterThanOrEqual(before);
    expect(canvasAfter).toBeCloseTo(canvasBefore - (after - before), 0);
    if (canvasBefore > 184) {
      expect(after).toBeGreaterThan(before);
      expect(canvasAfter).toBeGreaterThanOrEqual(159);
    }
    await page.screenshot({ path: testInfo.outputPath('phone-console-enlarged.png') });
    await ui.toggle.tap();
    await expect(ui.panel).toBeHidden();
    await ui.toggle.tap();
    expect(await height(ui.log)).toBe(after);
  });
});
