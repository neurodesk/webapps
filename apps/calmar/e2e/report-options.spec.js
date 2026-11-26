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
  test(`JHU tract overlap survives unavailable disconnection at ${width}px`, async ({ page }) => {
    test.setTimeout(120000);
    await page.setViewportSize({ width, height: 1000 });
    for (const entry of manifest.atlasAssets.filter(asset => asset.role === 'report-atlas')) {
      const bytes = await atlasBytes(entry);
      await page.route(entry.sourceUrl, route => route.fulfill({ body: bytes, contentType: 'application/octet-stream' }));
    }
    await page.goto('/');
    await page.waitForFunction(() => globalThis.app?.nv?.canvas);
    const measured = await page.evaluate(async () => {
      const { loadAtlasFromManifest } = await import('/js/modules/atlas-loader.js');
      const { writeNifti1 } = await import('/js/modules/nifti-writer.js');
      const atlas = await loadAtlasFromManifest('jhu-icbm-tracts-maxprob-thr50-2mm');
      const mask = new Uint8Array(atlas.data.length);
      let size = 0;
      let hit = 0;
      let outside = 0;
      for (let i = 0; i < mask.length; i++) {
        if (atlas.data[i] === 15) {
          size++;
          if (hit < 140) { mask[i] = 1; hit++; }
        } else if (atlas.data[i] === 0 && outside < 10) {
          mask[i] = 1;
          outside++;
        }
      }
      const bytes = writeNifti1(mask, { dims: atlas.dims, spacing: [2, 2, 2], affine: atlas.header.affine.flat() });
      await app.setLesion(new File([bytes], 'synthetic-jhu-overlap.nii'));
      app.disconnectomeClient = { query: async () => { throw new Error('Synthetic offline disconnection check'); } };
      await app.runKbReport();
      app.overlapResult = { summary: { networks: [] } };
      app.showResultsView();
      return { hit, size, rows: app.kbReport.context.jhuOverlap, findings: app.kbReport.result.rows.length };
    });
    expect(measured.hit).toBe(140);
    expect(measured.size).toBe(280);
    expect(measured.rows).toHaveLength(1);
    expect(measured.findings).toBeGreaterThan(0);
    const row = page.locator('.jhu-overlap-table tbody tr');
    await expect(row).toContainText('Superior longitudinal fasciculus L');
    await expect(row).toContainText('93.3%');
    await expect(row).toContainText('50.0%');
    await expect(page.locator('#kbWhiteMatterBody')).toContainText('Synthetic offline disconnection check');
    await expect(page.locator('#kbWhiteMatterBody')).toContainText('does not measure the patient');
    const parts = await page.evaluate(async () => {
      const { collectReportParts } = await import('/js/modules/report-export.js');
      return collectReportParts(document, ['whiteMatter']);
    });
    expect(parts[0].html).toContain('93.3%');
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => window.NeurodeskTheme.set(theme), theme);
      await page.locator('.jhu-overlap-table').scrollIntoViewIfNeeded();
      await page.screenshot({ path: test.info().outputPath(`jhu-${width}-${theme}.png`), fullPage: true, animations: 'disabled' });
    }
  });

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
    await page.screenshot({ path: join(directory, `results-${width}.png`), fullPage: true, animations: 'disabled' });
    await page.locator('.nd-app-bar:visible [data-neurodesk-theme-toggle]').first().click();
    await page.screenshot({ path: join(directory, `results-light-${width}.png`), fullPage: true, animations: 'disabled' });
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
    // Switching from the report decodes and uploads both NIfTI volumes before hiding it.
    await expect(page.locator('#resultsReport')).toBeHidden({ timeout: 30000 });
    expect(await page.evaluate(() => app.viewerLayerVisibility.lesion)).toBe(true);
    expect(await page.evaluate(() => app.centerCrosshairOnLesion())).toBe(true);
    const overlay = await page.evaluate(() => {
      const volume = app.nv.volumes[app.viewerController.getVolumeIndexForStage('segmentation')];
      return { voxels: Array.from(volume.img).filter(value => value > 0).length, opacity: volume.opacity };
    });
    expect(overlay.voxels).toBe(30);
    expect(overlay.opacity).toBeGreaterThan(0);
    const capture = await page.evaluate(() => {
      app.nv.scene.crosshairPos = [0.3, 0.4, 0.6];
      const images = app.captureLesionImages('both');
      return { images, crosshair: [...app.nv.scene.crosshairPos] };
    });
    expect(capture.images).toHaveLength(2);
    expect(capture.images[0].dataUrl).not.toBe(capture.images[1].dataUrl);
    expect(capture.crosshair).toEqual([0.3, 0.4, 0.6]);
    await page.evaluate(() => app.centerCrosshairOnLesion());
    const withMask = await page.locator('#gl1').screenshot();
    await page.evaluate(() => app.viewerController.setStageVisible('segmentation', false));
    const withoutMask = await page.locator('#gl1').screenshot();
    expect(withMask.equals(withoutMask), 'the lesion overlay must change the rendered scan').toBe(false);
    await page.evaluate(() => app.viewerController.setStageVisible('segmentation', true));
    await page.screenshot({ path: join(directory, `live-mask-${width}.png`), fullPage: true, animations: 'disabled' });
    await page.locator('.view-tab[data-view="results"]').click();
    const download = page.waitForEvent('download');
    await page.locator('#downloadOverlapCsv').click();
    expect((await readFile(await (await download).path(), 'utf8'))).toContain('Left Thalamus,20,0.6667');
  });

  test(`arterial territories 1 mm direct overlap and export at ${width}px`, async ({ page }) => {
    test.setTimeout(120000);
    await page.setViewportSize({ width, height: 900 });
    const option = manifest.atlasOptions.find(item => item.id === 'arterial');
    const entry = manifest.atlasAssets.find(item => item.id === option.overlapAtlasAssetId);
    const bytes = await atlasBytes(entry);
    await page.route(entry.sourceUrl, route => route.fulfill({ body: bytes, contentType: 'application/gzip' }));
    await page.goto('/');
    await page.waitForFunction(() => globalThis.app?.nv?.canvas);
    await page.locator('#kbEvidenceSelect').selectOption('off');
    await page.locator('#atlasSelect').selectOption('arterial');
    await page.getByRole('button', { name: '3. Results' }).click();
    await expect(page.locator('label[for="networkThresholdMinCluster"]')).toHaveText('Min overlap per territory (voxels)');
    // Set a custom cutoff (10 voxels) BEFORE running reporting analysis so we verify the pipeline does not reset it to 30.
    await page.locator('#networkThresholdMinCluster').fill('10');

    // Independently positioned MNI160 (160x160x192, origin [-80,-112,-80]) lesion with:
    //  - Left Middle Cerebral Artery (Frontal) landmark: 6x6x6 = 216 voxels (passes 10 and 30)
    //  - Right Inferior Cerebellar landmark: 4x4x3 = 48 voxels (infratentorial; passes 10 and 30)
    //  - Right Anterior Cerebral Artery landmark: 3x3x2 = 18 voxels (between 10 and 29 -> proves cutoff stays 10, not reset to 30)
    //  - Left Superior Cerebellar landmark: 3x2x1 = 6 voxels (< 10 -> filtered out of table, report, and CSV)
    //  - Left Lateral Ventricle interior core: 3x3x3 = 27 voxels (zeroed -> outside labeled arterial territory)
    // Total = 315 voxels (288 assigned, 27 outside).
    // Set up a confirmed MNI160 structural + lesion mask and stub only the ONNX registration / warp worker steps
    // so clicking "Run reporting analysis" drives the production registration bridge (applyRegistrationToLesion),
    // which runs resampleAffine + computeAtlasFovCoverage, saves app.registrationFovCoverage, then runs
    // parcel-overlap, fc-weighted-sum (skipped), threshold (preserving cutoff 10), and kb-report.
    await page.evaluate(async () => {
      const { writeNifti1 } = await import('/js/modules/nifti-writer.js');
      const { VOLUME_SPACES, tagSpatialFile } = await import('/js/modules/spatial-file.js');
      const mniDims = [160, 160, 192];
      const mniAffine = [
        [1, 0, 0, -80],
        [0, 1, 0, -112],
        [0, 0, 1, -80],
        [0, 0, 0, 1]
      ];
      const mniLesion = new Uint8Array(160 * 160 * 192);
      const paintWorldBox = (x0, x1, y0, y1, z0, z1) => {
        for (let z = z0; z <= z1; z++) {
          const k = z + 80;
          for (let y = y0; y <= y1; y++) {
            const j = y + 112;
            for (let x = x0; x <= x1; x++) {
              const i = x + 80;
              mniLesion[i + 160 * (j + 160 * k)] = 1;
            }
          }
        }
      };
      paintWorldBox(-40, -35, 18, 23, 16, 21); // Left Frontal MCA (216 voxels)
      paintWorldBox(24, 27, -68, -65, -45, -43); // Right Inferior Cerebellar (48 voxels)
      paintWorldBox(6, 8, 28, 30, 22, 23); // Right ACA (18 voxels; strictly between 10 and 29)
      paintWorldBox(-20, -18, -56, -55, -24, -24); // Left Superior Cerebellar (6 voxels; < 10 -> filtered out)
      paintWorldBox(-9, -7, -6, -4, 17, 19); // Left Lateral Ventricle interior core (27 outside voxels)

      const mniNifti = writeNifti1(mniLesion, { dims: mniDims, spacing: [1, 1, 1], affine: mniAffine.flat() });
      app.structuralFile = tagSpatialFile(new File([mniNifti], 'mni160-t1.nii'), {
        space: VOLUME_SPACES.MNI160,
        dims: mniDims,
        affine: mniAffine
      });
      app.lesionMaskFile = tagSpatialFile(new File([mniNifti], 'mni160-lesion-mask.nii'), {
        space: VOLUME_SPACES.MNI160,
        dims: mniDims,
        affine: mniAffine
      });
      app.lesionMaskConfirmed = true;
      app.runRegistration = async () => {
        app.hasRegistrationDisplacement = true;
      };
      app.executor.runWarpMask = async ({ maskBuffer, maskDims }) => {
        const echoed = writeNifti1(new Uint8Array(maskBuffer), {
          dims: maskDims,
          spacing: [1, 1, 1],
          affine: mniAffine.flat()
        });
        queueMicrotask(() => app.handleStageData({ stage: 'mni-lesion', niftiData: echoed }));
      };
    });

    // Drive the full registered-lesion reporting chain through the real UI Run reporting analysis button!
    await page.locator('#runFullPipelineButton').click();
    const rows = page.locator('#networkOverlapTable tbody tr');
    await expect(rows).toHaveCount(3, { timeout: 30000 });
    const bridged = await page.evaluate(() => ({
      lesionFileName: app.lesionFile?.name || null,
      unobservedVoxels: app.registrationFovCoverage?.unobservedVoxels ?? null,
      clippedCount: app.registrationFovCoverage?.clippedRegions?.length ?? null
    }));
    expect(bridged.lesionFileName).toBe('lnm-lesion-arterial.nii');
    expect(bridged.unobservedVoxels).toBe(110497);
    expect(bridged.clippedCount).toBe(4);
    const leftRow = rows.filter({ hasText: 'Left Middle Cerebral Artery (Frontal)' });
    await expect(leftRow).toContainText('216');
    await expect(leftRow).toContainText('68.6%');
    const rightCerebRow = rows.filter({ hasText: 'Right Inferior Cerebellar' });
    await expect(rightCerebRow).toContainText('48');
    await expect(rightCerebRow).toContainText('15.2%');
    const rightAcaRow = rows.filter({ hasText: 'Right Anterior Cerebral Artery' });
    await expect(rightAcaRow).toContainText('18');
    await expect(rightAcaRow).toContainText('5.7%');
    await expect(page.locator('#networkOverlapTable tbody')).not.toContainText('Left Superior Cerebellar');
    await expect(page.locator('#networkThresholdMinCluster')).toHaveValue('10');
    await expect(page.locator('#outsideAtlasWarning')).toBeVisible();
    await expect(page.locator('#outsideAtlasWarning')).toContainText('288 of 315 lesion voxels fall inside Arterial territories (Liu et al., 2023; 1 mm); 27 are outside labeled arterial territory.');
    await expect(page.locator('#outsideAtlasWarning')).toContainText('Registration FOV limit (MNI160 grid): 110,497 labeled atlas voxels');
    await expect(page.locator('#outsideAtlasWarning')).toContainText('Left Anterior Cerebral Artery 18.4%');
    await expect(page.locator('#outsideAtlasWarning')).toContainText('Right Anterior Cerebral Artery 18.5%');
    await expect(page.locator('#networkThresholdSummary')).toContainText('direct overlap only');
    await expect(page.locator('#thresholdControls')).toBeHidden();
    const help = page.getByLabel('Direct lesion overlap help', { exact: true });
    await help.focus();
    await expect(page.locator('#directOverlapHelp')).toContainText('Liu et al., 2023');
    await expect(page.locator('#directOverlapHelp')).not.toContainText('Cortical labels combine both hemispheres');
    const report = await page.evaluate(async () => {
      const { collectReportParts } = await import('/js/modules/report-export.js');
      const parts = collectReportParts(document, ['overlap']);
      const doc = new DOMParser().parseFromString(parts[0].html, 'text/html');
      const tableRows = Array.from(doc.querySelectorAll('tbody tr')).map(tr =>
        Array.from(tr.querySelectorAll('td')).map(td => td.textContent.trim())
      );
      return { html: parts[0].html, tableRows };
    });
    expect(report.tableRows).toHaveLength(3);
    expect(report.tableRows[0][0]).toBe('Left Middle Cerebral Artery (Frontal)');
    expect(report.tableRows[0][1]).toBe('216');
    expect(report.tableRows[0][2]).toBe('68.6%');
    expect(report.tableRows[1][0]).toBe('Right Inferior Cerebellar');
    expect(report.tableRows[1][1]).toBe('48');
    expect(report.tableRows[1][2]).toBe('15.2%');
    expect(report.tableRows[2][0]).toBe('Right Anterior Cerebral Artery');
    expect(report.tableRows[2][1]).toBe('18');
    expect(report.tableRows[2][2]).toBe('5.7%');
    expect(report.html).not.toContain('Left Superior Cerebellar');
    expect(report.html).toContain('110,497 labeled atlas voxels');
    const download = page.waitForEvent('download');
    await page.locator('#downloadOverlapCsv').click();
    const csv = await readFile(await (await download).path(), 'utf8');
    expect(csv).toContain('Left Middle Cerebral Artery (Frontal),216,0.6857');
    expect(csv).toContain('Right Inferior Cerebellar,48,0.1524');
    expect(csv).toContain('Right Anterior Cerebral Artery,18,0.0571');
    expect(csv).not.toContain('Left Superior Cerebellar');
    await page.screenshot({ path: test.info().outputPath(`arterial-${width}.png`), fullPage: true, animations: 'disabled' });

    // Exercise the real viewer stack + layer-toggle path (no renderPatientLayerStack stub):
    // 1) showSubjectSpaceAtlas() on arterial loads the real atlas-qc overlay into NiiVue and surfaces
    //    the FOV clipping warning visibly in #statusText while the technical log remains collapsed.
    // 2) Switching #atlasSelect to Schaefer removes the stale arterial atlas-qc overlay from NiiVue,
    //    clears the footer clipping warning, and unchecks #layerToggleAtlasQc.
    // 3) Re-enabling #layerToggleAtlasQc projects and loads Schaefer (never re-showing arterial).
    // 4) Two-request queued QC race discards stale arterial bytes and keeps Schaefer bytes.
    const qcSetup = await page.evaluate(async () => {
      const { writeNifti1 } = await import('/js/modules/nifti-writer.js');
      const { VOLUME_SPACES, tagSpatialFile } = await import('/js/modules/spatial-file.js');
      const qcDims = [4, 4, 4];
      const qcAffine = [
        [1, 0, 0, 0],
        [0, 1, 0, 0],
        [0, 0, 1, 0],
        [0, 0, 0, 1]
      ];
      const t1Data = new Uint8Array(64).fill(100);
      const arterialData = new Uint8Array(64).fill(7);
      const schaeferData = new Uint8Array(64).fill(3);
      const t1Nifti = writeNifti1(t1Data, { dims: qcDims, spacing: [1, 1, 1], affine: qcAffine.flat() });
      const arterialNifti = writeNifti1(arterialData, { dims: qcDims, spacing: [1, 1, 1], affine: qcAffine.flat() });
      const schaeferNifti = writeNifti1(schaeferData, { dims: qcDims, spacing: [1, 1, 1], affine: qcAffine.flat() });
      window.__qcFixtures = { arterialNifti, schaeferNifti };
      window.__qcDispatched = [];

      app.structuralFile = tagSpatialFile(new File([t1Nifti], 'patient-t1-qc.nii'), {
        space: VOLUME_SPACES.MNI160,
        dims: qcDims,
        affine: qcAffine
      });
      app.hasRegistrationDisplacement = true;
      const arterialFov = app.registrationFovCoverage;
      app.projectAtlasToMni160Grid = async () => {
        const option = app.getAtlasOption();
        return {
          labels: new Uint8Array(64).fill(1),
          dims: qcDims,
          affine: qcAffine,
          atlasOption: option,
          fovCoverage: option.id === 'arterial'
            ? arterialFov
            : { atlasId: option.id, totalLabeledVoxels: 64, unobservedVoxels: 0, unobservedFraction: 0, clippedRegions: [] }
        };
      };
      app.executor.runInverseWarpMask = async (settings) => {
        window.__qcDispatched.push(settings.description);
      };

      const showArterial = app.showSubjectSpaceAtlas();
      while (window.__qcDispatched.length < 1) await new Promise(resolve => setTimeout(resolve, 5));
      app.handleStageData({ stage: 'atlas-patient', niftiData: arterialNifti.slice(0) });
      app.handleStepComplete('inverse-warp-mask');
      await showArterial;
      return {
        hasAtlasStage: app.viewerController.getVolumeIndexForStage('atlas-qc') !== null,
        status: document.getElementById('statusText')?.textContent || '',
        toggleChecked: document.getElementById('layerToggleAtlasQc')?.checked ?? null
      };
    });
    expect(qcSetup.hasAtlasStage).toBe(true);
    expect(qcSetup.status).toBe('Atlas QC displayed: 110,497 labeled voxels clipped outside MNI160 FOV (4 territories).');
    expect(qcSetup.toggleChecked).toBe(true);

    // Switch atlas via the real UI dropdown: stale arterial QC overlay and footer warning must clear immediately.
    await page.locator('#atlasSelect').selectOption('schaefer400');
    const afterSwitch = await page.evaluate(() => ({
      hasAtlasStage: app.viewerController.getVolumeIndexForStage('atlas-qc') !== null,
      status: document.getElementById('statusText')?.textContent || '',
      toggleChecked: document.getElementById('layerToggleAtlasQc')?.checked ?? null
    }));
    expect(afterSwitch.hasAtlasStage).toBe(false);
    expect(afterSwitch.status).toBe('Atlas set to Schaefer 400 parcels.');
    expect(afterSwitch.toggleChecked).toBe(false);

    // Re-enabling the real Atlas QC layer toggle must project and load Schaefer, not re-show arterial.
    await page.locator('#layerToggleAtlasQc').check();
    const afterToggle = await page.evaluate(async () => {
      while (window.__qcDispatched.length < 2) await new Promise(resolve => setTimeout(resolve, 5));
      app.handleStageData({ stage: 'atlas-patient', niftiData: window.__qcFixtures.schaeferNifti.slice(0) });
      app.handleStepComplete('inverse-warp-mask');
      const deadline = Date.now() + 5000;
      while (app.viewerController.getVolumeIndexForStage('atlas-qc') === null && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      return {
        hasAtlasStage: app.viewerController.getVolumeIndexForStage('atlas-qc') !== null,
        fileName: app.patientAtlasFile?.name || null,
        status: document.getElementById('statusText')?.textContent || ''
      };
    });
    expect(afterToggle.hasAtlasStage).toBe(true);
    expect(afterToggle.fileName).toBe('lnm-schaefer400-atlas-patient.nii');
    expect(afterToggle.status).toBe('Atlas alignment QC overlay displayed.');

    // Two-request queued QC race: start arterial QC, switch to Schaefer, queue Schaefer before arterial replies.
    const qcRace = await page.evaluate(async () => {
      app.handleAtlasSelectionChange('arterial');
      const startCount = window.__qcDispatched.length;
      const reqArterial = app.projectAtlasToPatientSpace();
      while (window.__qcDispatched.length < startCount + 1) await new Promise(resolve => setTimeout(resolve, 5));
      app.handleAtlasSelectionChange('schaefer400');
      const reqSchaefer = app.projectAtlasToPatientSpace();
      await new Promise(resolve => setTimeout(resolve, 10));
      const queuedBeforeFirstReply = window.__qcDispatched.length - startCount;
      app.handleStageData({ stage: 'atlas-patient', niftiData: new Uint8Array([0xaa, 0xaa, 0xaa, 0xaa]).buffer });
      app.handleStepComplete('inverse-warp-mask');
      const arterialRaceResult = await reqArterial;
      while (window.__qcDispatched.length < startCount + 2) await new Promise(resolve => setTimeout(resolve, 5));
      app.handleStageData({ stage: 'atlas-patient', niftiData: new Uint8Array([0xbb, 0xbb, 0xbb, 0xbb]).buffer });
      app.handleStepComplete('inverse-warp-mask');
      const schaeferRaceResult = await reqSchaefer;
      const schaeferBytes = schaeferRaceResult ? Array.from(new Uint8Array(await schaeferRaceResult.arrayBuffer())) : null;
      return {
        queuedBeforeFirstReply,
        arterialRaceResult,
        schaeferName: schaeferRaceResult?.name || null,
        schaeferBytes,
        selected: app.selectedAtlasOptionId
      };
    });
    expect(qcRace.queuedBeforeFirstReply).toBe(1);
    expect(qcRace.arterialRaceResult).toBeNull();
    expect(qcRace.schaeferName).toBe('lnm-schaefer400-atlas-patient.nii');
    expect(qcRace.schaeferBytes).toEqual([0xbb, 0xbb, 0xbb, 0xbb]);
    expect(qcRace.selected).toBe('schaefer400');
  });
}
