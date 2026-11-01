import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const manifest = JSON.parse(await readFile(new URL('../web/models/manifest.json', import.meta.url)));
const directory = join(process.env.TMPDIR || process.env.RUNNER_TEMP, 'calmar-report-options');

async function atlasBytes(entry) {
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${entry.id}.nii.gz`);
  let bytes = await readFile(path).catch(() => null);
  const digest = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
  if (!bytes || digest(bytes) !== entry.checksum) {
    const response = await fetch(entry.sourceUrl);
    expect(response.ok).toBe(true);
    bytes = Buffer.from(await response.arrayBuffer());
    expect(digest(bytes)).toBe(entry.checksum);
    await writeFile(path, bytes);
  }
  return bytes;
}

for (const width of [1440, 390]) {
  test(`combined Harvard–Oxford overlap and optional evidence at ${width}px`, async ({ page }) => {
    test.setTimeout(120000);
    await page.setViewportSize({ width, height: 900 });
    const option = manifest.atlasOptions.find(item => item.id === 'harvardoxford');
    for (const id of [option.overlapAtlasAssetId, option.subcorticalAtlasAssetId]) {
      const entry = manifest.atlasAssets.find(item => item.id === id);
      const bytes = await atlasBytes(entry);
      await page.route(entry.sourceUrl, route => route.fulfill({ body: bytes, contentType: 'application/octet-stream' }));
    }
    await page.goto('/');
    await page.waitForFunction(() => globalThis.app?.nv?.canvas);
    await page.locator('#kbEvidenceSelect').selectOption('off');
    await page.locator('#atlasSelect').selectOption('harvardoxford');
    const measured = await page.evaluate(async () => {
      const { loadAtlasFromManifest } = await import('/js/modules/atlas-loader.js');
      const { writeNifti1 } = await import('/js/modules/nifti-writer.js');
      document.getElementById('networkThresholdMinCluster').value = '0';
      const option = app.getAtlasOption();
      const atlas = await loadAtlasFromManifest(option.overlapAtlasAssetId, { subcorticalAssetId: option.subcorticalAtlasAssetId });
      const mask = new Uint8Array(atlas.data.length);
      let cortical = 0;
      let subcortical = 0;
      let subcorticalSize = 0;
      for (let i = 0; i < mask.length; i++) {
        if (atlas.data[i] === 52) {
          subcorticalSize++;
          if (subcortical < 20) {
            mask[i] = 1;
            subcortical++;
          }
        } else if (atlas.data[i] === 1 && cortical < 10) {
          mask[i] = 1;
          cortical++;
        }
      }
      const bytes = writeNifti1(mask, { dims: atlas.dims, spacing: [2, 2, 2], affine: atlas.header.affine.flat() });
      await app.setLesion(new File([bytes], 'synthetic-overlap-check.nii'));
      await app.runAtlasOverlap({ showResults: true });
      await app.runFcNetworkMap();
      await app.runKbReport();
      return { cortical, subcortical, subcorticalSize, kb: app.kbReport };
    });
    expect(measured.cortical).toBe(10);
    expect(measured.subcortical).toBe(20);
    expect(measured.kb).toBeNull();
    const row = page.locator('#networkOverlapTable tbody tr').filter({ hasText: 'Left Thalamus' });
    await expect(row).toContainText('66.7%');
    await expect(row).toContainText(`${(2000 / measured.subcorticalSize).toFixed(1)}%`);
    await expect(page.locator('#kbReportHeading')).toBeHidden();
    await expect(page.locator('#networkThresholdSummary')).toContainText('direct overlap only');
    const method = page.locator('#resultsMethod details');
    await expect(method).not.toHaveAttribute('open');
    await method.locator('summary').click();
    await expect(method.locator('ol li')).toHaveCount(2);
    await method.locator('summary').click();
    const help = page.getByLabel('Direct lesion overlap help', { exact: true });
    await help.focus();
    await expect(page.locator('#directOverlapHelp')).toBeVisible();
    await expect(page.locator('#directOverlapHelp')).toContainText('ROI covered % =');
    await expect(page.locator('#scanConfirmation')).toBeVisible();
    await expect(page.locator('#resultsReport')).not.toContainText('Understanding the percentages');
    await page.screenshot({ path: join(directory, `results-${width}.png`), fullPage: true });
    await page.locator('.nd-app-bar:visible [data-neurodesk-theme-toggle]').first().click();
    await page.screenshot({ path: join(directory, `results-light-${width}.png`), fullPage: true });
    await page.evaluate(async () => {
      const { writeNifti1 } = await import('/js/modules/nifti-writer.js');
      const atlas = app.overlapResult.atlas;
      const anatomy = new Uint8Array(atlas.data.length);
      for (let i = 0; i < anatomy.length; i++) anatomy[i] = atlas.data[i] ? 80 : 0;
      const bytes = writeNifti1(anatomy, { dims: atlas.dims, spacing: [2, 2, 2], affine: atlas.header.affine.flat() });
      app.nativeStructuralFile = app.tagFileSpace(new File([bytes], 'synthetic-anatomy.nii'), { space: 'native-t1' });
      app.confirmedNativeLesionFile = app.tagFileSpace(new File([await app.lesionFile.arrayBuffer()], 'confirmed-native-mask.nii'), { space: 'native-t1' });
      app.viewerLayerVisibility.lesion = false;
    });
    await page.locator('#captureReportScan').click();
    await expect(page.locator('#resultsReport')).toBeHidden();
    expect(await page.evaluate(() => app.viewerLayerVisibility.lesion)).toBe(true);
    expect(await page.evaluate(() => app.centerCrosshairOnLesion())).toBe(true);
    const overlay = await page.evaluate(() => {
      const volume = app.nv.volumes[app.viewerController.getVolumeIndexForStage('segmentation')];
      return { voxels: Array.from(volume.img).filter(value => value > 0).length, opacity: volume.opacity };
    });
    expect(overlay.voxels).toBe(30);
    expect(overlay.opacity).toBeGreaterThan(0);
    const withMask = await page.locator('#gl1').screenshot();
    await page.evaluate(() => app.viewerController.setStageVisible('segmentation', false));
    const withoutMask = await page.locator('#gl1').screenshot();
    expect(withMask.equals(withoutMask), 'the lesion overlay must change the rendered scan').toBe(false);
    await page.evaluate(() => app.viewerController.setStageVisible('segmentation', true));
    await page.screenshot({ path: join(directory, `live-mask-${width}.png`), fullPage: true });
    await page.locator('.view-tab[data-view="results"]').click();
    const download = page.waitForEvent('download');
    await page.locator('#downloadOverlapCsv').click();
    expect((await readFile(await (await download).path(), 'utf8'))).toContain('Left Thalamus,20,0.6667');
  });
}
