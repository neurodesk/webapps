import { expect, test } from '@playwright/test';

for (const width of [1440, 390]) {
  test(`lasso, sortable overlap and behavioural context at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto('/');
    await page.waitForFunction(() => globalThis.app?.nv?.canvas);
    await page.evaluate(async () => {
      const { writeNifti1 } = await import('/js/modules/nifti-writer.js');
      const data = new Float32Array(64 ** 3);
      for (let z = 0; z < 64; z++) {
        for (let y = 0; y < 64; y++) {
          for (let x = 0; x < 64; x++) data[x + y * 64 + z * 4096] = 20 + x + y + z;
        }
      }
      const bytes = writeNifti1(data, { dims: [64, 64, 64], spacing: [1, 1, 1], affine: [1, 0, 0, -32, 0, 1, 0, -32, 0, 0, 1, -32, 0, 0, 0, 1] });
      await app.setStructural(new File([bytes], 'synthetic-manual-review.nii'));
      await app.startLesionMaskReview({ blank: true });
      app.setViewerView('axial');
    });
    await page.locator('#maskLassoButton').click();
    await expect(page.locator('#maskLassoButton')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#maskFilledToggle')).toBeChecked();
    await expect(page.locator('#maskShapeSelect')).toBeDisabled();
    const canvas = page.locator('#gl1');
    await canvas.scrollIntoViewIfNeeded();
    const box = await canvas.boundingBox();
    const half = Math.min(90, box.width * 0.25, box.height * 0.25);
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx - half, cy - half);
    await page.mouse.down();
    await page.mouse.move(cx + half, cy - half, { steps: 20 });
    await page.mouse.move(cx + half, cy + half, { steps: 20 });
    await page.mouse.move(cx - half, cy + half, { steps: 20 });
    await page.mouse.up();
    const drawn = await page.evaluate(() => {
      const bitmap = app.nv.drawBitmap;
      const points = [];
      for (let index = 0; index < bitmap.length; index++) {
        if (bitmap[index]) points.push([index % 64, Math.floor(index / 64) % 64, Math.floor(index / 4096)]);
      }
      const spans = [0, 1, 2].map(axis => Math.max(...points.map(p => p[axis])) - Math.min(...points.map(p => p[axis])) + 1);
      return { count: points.length, spans, density: points.length / spans.reduce((a, b) => a * b, 1), confirmed: app.lesionMaskConfirmed };
    });
    expect(drawn.count).toBeGreaterThan(50);
    expect(drawn.spans).toContain(1);
    expect(drawn.density).toBeGreaterThan(0.75);
    expect(drawn.confirmed).toBe(false);
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => window.NeurodeskTheme.set(theme), theme);
      await page.screenshot({ path: test.info().outputPath(`lasso-${width}-${theme}.png`), fullPage: true });
    }
    await page.locator('#maskUndoButton').click();
    expect(await page.evaluate(() => app.nv.drawBitmap.some(value => value > 0))).toBe(false);
    await page.locator('#maskPaintButton').click();
    await expect(page.locator('#maskFilledToggle')).not.toBeChecked();
    await expect(page.locator('#maskBrushSize')).toBeEnabled();

    await page.locator('#patientBehaviorOptions summary').click();
    await page.locator('#patientBehaviorNotes').fill('Naming difficulty observed during conversation.');
    await page.getByLabel('Assessment name', { exact: true }).fill('Naming assessment');
    await page.getByLabel('Score / result', { exact: true }).fill('12/60');
    await page.getByLabel('Assessment date', { exact: true }).fill('2026-11-02');
    await page.locator('#patientBehaviorOptions summary').click();
    await page.evaluate(async () => {
      const { renderOverlapTable } = await import('/js/modules/overlap-render.js');
      const networks = Array.from({ length: 20 }, (_, i) => ({ network: `ROI ${i + 1}`, voxelsInLesion: i + 1, fractionOfLesion: (i + 1) / 210 }));
      renderOverlapTable(document.getElementById('networkOverlapTable'), { networks }, { networkSizes: Object.fromEntries(networks.map(row => [row.network, 100])) });
      app.nv.drawBitmap[32 + 32 * 64 + 32 * 4096] = 1;
      await app.confirmLesionDrawing({ resumePipeline: false });
      app.overlapResult = { summary: { networks } };
      app.showResultsView();
    });
    const table = page.locator('#networkOverlapTable');
    await table.getByRole('button', { name: 'Sort by Voxels', exact: true }).click();
    await expect(table.locator('tbody tr').first()).toContainText('ROI 20');
    await table.getByRole('button', { name: 'Sort by Voxels', exact: true }).press('Enter');
    await expect(table.locator('tbody tr').first()).toContainText('ROI 1');
    await table.getByRole('button', { name: 'Show all 20 labels' }).click();
    await table.getByRole('button', { name: 'Sort by ROI covered %', exact: true }).click();
    await expect(table.locator('tbody tr.overlap-row-extra:visible')).toHaveCount(8);
    await expect(page.locator('#patientBehaviorReport')).toContainText('12/60');
    await expect(page.locator('#patientBehaviorReport')).toContainText('Naming difficulty');
    const exported = await page.evaluate(async () => {
      const { collectReportParts } = await import('/js/modules/report-export.js');
      return collectReportParts(document, ['behavior', 'overlap']);
    });
    expect(exported.map(part => part.id)).toEqual(['behavior', 'overlap']);
    expect(exported[1].html).toContain('ROI covered %</th>');
    await page.locator('#resultsReport').evaluate(element => element.scrollTop = 0);
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => window.NeurodeskTheme.set(theme), theme);
      await page.screenshot({ path: test.info().outputPath(`results-${width}-${theme}.png`), fullPage: true });
    }
    await page.locator('#patientBehaviorOptions summary').click();
    await page.locator('#includePatientBehavior').uncheck();
    await expect(page.locator('#patientBehaviorReport')).toBeHidden();
    await expect(page.locator('#patientBehaviorNotes')).toHaveValue('Naming difficulty observed during conversation.');
    await page.evaluate(async () => {
      const bytes = await app.nativeStructuralFile.arrayBuffer();
      await app.setStructural(new File([bytes], 'synthetic-second-subject.nii'));
    });
    await expect(page.locator('#patientBehaviorNotes')).toHaveValue('');
    await expect(page.locator('#patientBehaviorReport')).toBeHidden();
  });
}
