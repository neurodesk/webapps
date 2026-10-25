#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { loadAppsRegistry, repoRoot } from '../scripts/lib/apps-registry.mjs';
import { serveSite } from '../test-utils/serve-site.mjs';
import { dicomSeries } from '../test-utils/dicom-fixture.mjs';
import { bidsTree, dropFolder } from '../test-utils/bids-folder-drop.mjs';

function nifti(name, value = 20) {
  const buffer = Buffer.alloc(352 + 4096, 0);
  buffer.writeInt32LE(348, 0);
  [3,16,16,16,1,1,1,1].forEach((n,i) => buffer.writeInt16LE(n,40+i*2));
  buffer.writeInt16LE(2,70); buffer.writeInt16LE(8,72);
  for (let i=0;i<8;i++) buffer.writeFloatLE(1,76+i*4);
  buffer.writeFloatLE(352,108); buffer.writeFloatLE(1,112); buffer.write('n+1\0',344);
  buffer.fill(value,352);
  return { name, mimeType:'application/octet-stream', buffer };
}
// A 16^3 float32 DWI of 13 volumes with its bval and bvec: one b0, then the same six unit
// directions at b = 1000 and 2000, the smallest table noddi fits both a tensor and NODDI to.
function dwiSeries(stem = 'interface-dwi') {
  const voxels = 16 * 16 * 16;
  const directions = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [Math.SQRT1_2, Math.SQRT1_2, 0], [Math.SQRT1_2, 0, Math.SQRT1_2], [0, Math.SQRT1_2, Math.SQRT1_2]];
  const bvals = [0, ...directions.map(() => 1000), ...directions.map(() => 2000)];
  const bvecs = [[0, 0, 0], ...directions, ...directions];
  const buffer = Buffer.alloc(352 + voxels * bvals.length * 4, 0);
  buffer.writeInt32LE(348, 0);
  [4, 16, 16, 16, bvals.length, 1, 1, 1].forEach((n, i) => buffer.writeInt16LE(n, 40 + i * 2));
  buffer.writeInt16LE(16, 70);
  buffer.writeInt16LE(32, 72);
  for (let i = 0; i < 8; i++) buffer.writeFloatLE(1, 76 + i * 4);
  buffer.writeFloatLE(352, 108);
  buffer.writeFloatLE(1, 112);
  buffer.write('n+1\0', 344);
  bvals.forEach((b, volume) => {
    for (let v = 0; v < voxels; v++) buffer.writeFloatLE(b ? 400 : 1000, 352 + (volume * voxels + v) * 4);
  });
  return [
    { name: `${stem}.nii`, mimeType: 'application/octet-stream', buffer },
    { name: `${stem}.bval`, mimeType: 'text/plain', buffer: Buffer.from(`${bvals.join(' ')}\n`) },
    { name: `${stem}.bvec`, mimeType: 'text/plain', buffer: Buffer.from(`${[0, 1, 2].map(axis => bvecs.map(g => g[axis]).join(' ')).join('\n')}\n`) },
  ];
}
// A BIDS folder with two runs gives a run selector; the run chosen after loading must survive
// closing and opening the input section.
async function checkBidsRun(page) {
  await expect(page.locator('#runSelect')).toBeHidden();
  await dropFolder(page, bidsTree(dwiSeries('sub-01_dwi')));
  await expect(page.locator('#fileInfo')).toContainText('sub-01_run-1_dwi.nii');
  await page.locator('#runSelect').selectOption({ label: 'sub-01_run-2_dwi' });
  await expect(page.locator('#fileInfo')).toContainText('sub-01_run-2_dwi.nii');
  const input = page.locator('#inputSection > summary');
  await input.tap();
  await expect(page.locator('#runSelect')).toBeHidden();
  await input.tap();
  await expect(page.locator('#runSelect')).toHaveValue('1');
}
const apps = (await loadAppsRegistry()).apps;
const site = await serveSite(join(repoRoot, 'dist'));
const browser = await chromium.launch({ args:['--enable-webgl','--use-gl=angle','--use-angle=swiftshader'] });
const failures = [];
async function check(id, workflow) {
  if (process.env.SMOKE_APPS && !process.env.SMOKE_APPS.split(',').includes(id)) return;
  const app = apps.find(app => app.id === id);
  if (!app) throw new Error(`Unknown app ${id}`);
  const page = await browser.newPage({ viewport:{width:390,height:844}, isMobile:true, hasTouch:true });
  page.setDefaultTimeout(20000);
  try {
    await page.goto(`${site.origin}/${app.path}/`, { waitUntil:'domcontentloaded' });
    const enter = page.locator('#enterAppButton:visible, #landingLaunch:visible');
    if (await enter.count()) await enter.first().tap();
    const workspace = page.getByRole('link',{name:'Open Workspace',exact:true});
    if (await workspace.isVisible()) await workspace.tap();
    await workflow(page);
    console.log(`PASS ${id}: workflow disclosures and retained state`);
  } catch(error) { failures.push(`${id}: ${error.message}`); }
  finally { await page.close(); }
}
try {
  await check('me-ica', async page => {
    await page.locator('#advancedSettings > summary').tap();
    await page.locator('#seed').fill('17');
    await page.locator('#tedpca').selectOption('kic');
    await page.locator('#advancedSettings > summary').tap();
    await expect(page.locator('#seed')).toBeHidden();
    const echoes = [1, 2, 3].flatMap(index => [
      nifti(`echo-${index}.nii`),
      { name: `echo-${index}.json`, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ EchoTime: index * 0.015 })) },
    ]);
    await page.locator('#imageInput').setInputFiles(echoes);
    await expect(page.locator('#runButton')).toBeEnabled();
    await expect(page.locator('#imageLabel')).toContainText('echo-1.nii');
    await page.locator('#inputSection > summary').tap();
    await expect(page.locator('#echoTimes')).toBeHidden();
    await page.locator('#inputSection > summary').tap();
    await expect(page.locator('#echoTimes')).toHaveValue('15 30 45');
    await page.locator('#advancedSettings > summary').tap();
    await expect(page.locator('#seed')).toHaveValue('17');
    await expect(page.locator('#tedpca')).toHaveValue('kic');
  });
  await check('dcm2niix', async page => {
    await page.locator('#subject').fill('subject01');
    await page.locator('#session').fill('baseline');
    await page.locator('#taskSection > summary').tap();
    await page.locator('#taskSection > summary').tap();
    await expect(page.locator('#subject')).toHaveValue('subject01');
    await expect(page.locator('#session')).toHaveValue('baseline');
    await page.locator('#imageInput').setInputFiles(dicomSeries());
    await expect(page.locator('#seriesRows tr')).toHaveCount(1, { timeout: 120000 });
    await page.locator('#seriesRows select').selectOption('T1w');
    await page.locator('#seriesRows input[type=checkbox]').check();
    await page.locator('#privacy').selectOption('omit');
    const pending = page.waitForEvent('download');
    await page.locator('#runButton').tap();
    await pending;
    await expect(page.locator('#statusText')).toHaveText('BIDS dataset ready');
  });
  await check('lcmodel', async page => {
    await page.locator('#waterSection > summary').tap();
    await expect(page.locator('#waterInput')).toBeDisabled();
    await page.locator('#fitSettings > summary').tap();
    await page.locator('#lineBroadening').selectOption('lcmodel');
    await page.locator('#fitSettings > summary').tap();
    await expect(page.locator('#lineBroadening')).toBeHidden();
    await page.locator('#fitSettings > summary').tap();
    await expect(page.locator('#lineBroadening')).toHaveValue('lcmodel');
    await page.locator('#dataInput').setInputFiles(nifti('interface-t1.nii'));
    await expect(page.locator('#t1Canvas')).toBeVisible();
    await page.locator('#fGm').fill('0.6');
    await page.locator('#fWm').fill('0.3');
    await page.locator('#fCsf').fill('0.1');
    await page.locator('#tissueSection > summary').tap();
    await expect(page.locator('#fGm')).toBeHidden();
    await page.locator('#tissueSection > summary').tap();
    await expect(page.locator('#fGm')).toHaveValue('0.6');
    await expect(page.locator('#fWm')).toHaveValue('0.3');
    await expect(page.locator('#fCsf')).toHaveValue('0.1');
    await expect(page.locator('#viewerNotice')).toBeHidden();
  });
  await check('seedseg', async page => {
    const settings = page.locator('#seedseg-section-2 [data-disclosure-toggle]');
    await settings.tap();
    await page.locator('#probThreshold').fill('0.25');
    await page.locator('#nMarkers').fill('2');
    await page.locator('#model3').uncheck();
    await settings.tap();
    await expect(page.locator('#probThreshold')).toBeHidden();
    await settings.tap();
    await expect(page.locator('#probThreshold')).toHaveValue('0.25');
    await expect(page.locator('#nMarkers')).toHaveValue('2');
    await expect(page.locator('#model3')).not.toBeChecked();
    await expect(page.locator('#seedseg-log')).toHaveClass(/collapsed/);
  });
  await check('vesselboost', async page => {
    await page.locator('#fileInput').setInputFiles(nifti('automation-input.nii'));
    await expect(page.locator('#runDownsampleBtn')).toBeEnabled();
    await expect(page.locator('#status')).toContainText('complete');
    for (const [section, action] of [
      ['stepDownsampleSection', 'skipDownsampleBtn'],
      ['stepN4Section', 'skipN4Btn'],
      ['stepDenoiseSection', 'skipDenoiseBtn'],
    ]) {
      await page.locator(`#${section} [data-disclosure-toggle]`).tap();
      await page.locator(`#${action}`).tap();
    }
    await expect(page.locator('#runSegmentation')).toBeEnabled();
    await page.locator('#modelSelect').selectOption('omelette1');
    await page.locator('#thresholdInput').fill('0.2');
    const toggle = page.locator('#stepInferenceSection [data-disclosure-toggle]');
    await toggle.tap();
    await toggle.tap();
    await expect(page.locator('#modelSelect')).toHaveValue('omelette1');
    await expect(page.locator('#thresholdInput')).toHaveValue('0.2');
    await expect(page.locator('#vesselboost-log')).toHaveClass(/collapsed/);
    await expect(page.locator('#runSegmentation')).toBeEnabled();
  });
  await check('qsmbly', async page => {
    await expect(page.locator('#unifiedFiles')).toBeEnabled({ timeout: 120000 });
    const toggle = page.locator('#paramsSection [data-disclosure-toggle]');
    await toggle.tap();
    await page.locator('#magField').fill('7');
    await page.locator('[data-neurodesk-shell-control="cite"]').tap();
    const dialog = page.locator('.nd-app-dialog[data-dialog="cite"]');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('HD-BET');
    await expect(dialog).toContainText('Single-step TGV');
    await dialog.locator('.nd-app-dialog__close').tap();
    await expect(dialog).toBeHidden();
    await expect(page.locator('#magField')).toHaveValue('7');
    await toggle.tap();
    await expect(page.locator('#magField')).toBeHidden();
    await toggle.tap();
    await expect(page.locator('#magField')).toHaveValue('7');
  });
  await check('browserqc', async page => {
    await page.locator('#modelPick').selectOption('mindmap')
    await page.locator('#processingSection > summary').tap()
    await page.locator('#processingSection > summary').tap()
    await expect(page.locator('#modelPick')).toHaveValue('mindmap')
    await page.locator('#ratingSection > summary').tap()
    await page.locator('#rateComments').fill('Review later')
    await page.locator('#ratingSection > summary').tap()
    await page.locator('#ratingSection > summary').tap()
    await expect(page.locator('#rateComments')).toHaveValue('Review later')
    await expect(page.locator('#rateSave')).toBeDisabled()
    await page.locator('#viewPick').selectOption('background')
    await expect(page.locator('#viewPick')).toHaveValue('background')
  })
  await check('nesvor', async page => {
    await page.locator('#imageInput').setInputFiles(nifti('stack.nii'));
    await expect(page.locator('#fileInfo')).toContainText('1 stack loaded');
    await page.locator('#thickness-0').fill('3.2');
    await page.locator('#inputSection > summary').tap();
    await page.locator('#inputSection > summary').tap();
    await expect(page.locator('#thickness-0')).toHaveValue('3.2');
    await page.locator('#executionMode').selectOption('browser-reference');
    await page.locator('#computeSection > summary').tap();
    await page.locator('#computeSection > summary').tap();
    await expect(page.locator('#executionMode')).toHaveValue('browser-reference');
    await expect(page.locator('#runButton')).toBeDisabled();
    await expect(page.locator('#technicalLog')).not.toHaveAttribute('open', '');
  });
  await check('brain-extraction', async page => {
    await page.locator('#imageInput').setInputFiles(nifti('automation-input.nii'));
    await expect(page.locator('#statusText')).toHaveAttribute('data-neurodesk-state', 'ready');
    await page.locator('#method').selectOption('bet');
    await page.locator('#advancedSettings > summary').tap();
    await page.locator('#threshold').fill('0.4');
    await page.locator('#advancedSettings > summary').tap();
    await page.locator('#advancedSettings > summary').tap();
    await expect(page.locator('#threshold')).toHaveValue('0.4');
    await expect(page.locator('#reportBtn')).toBeDisabled();
    await expect(page.locator('#outputSection')).not.toHaveAttribute('open', '');
  });
  await check('synthseg', async page => {
    await page.locator('#imageInput').setInputFiles(nifti('automation-input.nii'));
    await expect(page.locator('#fileInfo')).toContainText('automation-input.nii');
    await expect(page.locator('#mode')).toBeEnabled();
    await page.locator('#mode').selectOption('fast');
    const section = page.locator('#mode').locator('xpath=ancestor::details[1]');
    await section.locator(':scope > summary').tap();
    await section.locator(':scope > summary').tap();
    await expect(page.locator('#mode')).toHaveValue('fast');
    await expect(page.locator('#reportBtn')).toBeDisabled();
    await expect(page.locator('#outputSection')).not.toHaveAttribute('open', '');
  });
  await check('carotid-flow', async page => {
    await expect(page.locator('#statusText')).toHaveText('Drag and drop files', { timeout: 60000 });
    const advanced = page.locator('#advancedSettings > summary');
    await advanced.tap();
    await page.locator('#candidatePercentile').fill('99.5');
    const task = page.locator('#taskSection > summary');
    await task.tap();
    await expect(page.locator('#candidatePercentile')).toBeHidden();
    await task.tap();
    await expect(page.locator('#candidatePercentile')).toHaveValue('99.5');
    await page.locator('#imageInput').setInputFiles(nifti('interface-volume.nii'));
    await expect(page.locator('#statusText')).toContainText('has 16 slices');
    await expect(page.locator('#runButton')).toBeDisabled();
    await expect(page.locator('#outputSection')).not.toHaveAttribute('open', '');
  });
  await check('disconnectome', async page => {
    await expect(page.locator('#statusText')).toHaveText('Drag and drop files', { timeout: 60000 });
    await page.locator('#imageInput').setInputFiles(nifti('interface-lesion.nii'));
    await expect(page.locator('#runButton')).toBeEnabled();
    const inputs = page.locator('#inputSection > summary');
    await inputs.tap();
    await expect(page.locator('#imageInput')).toBeHidden();
    await inputs.tap();
    await expect(page.locator('#lesionInfo')).toContainText('interface-lesion.nii');
    await expect(page.locator('#runButton')).toBeEnabled();
    const outputs = page.locator('#outputSection > summary');
    await outputs.tap();
    await page.locator('#threshold').fill('60');
    await outputs.tap();
    await outputs.tap();
    await expect(page.locator('#threshold')).toHaveValue('60');
    await expect(page.locator('#saveButton')).toBeDisabled();
  });
  await check('white-matter-lesions', async page => {
    const status = page.locator('footer#status #statusText');
    await expect(status).toHaveText('Drag and drop files', { timeout: 60000 });
    await expect(page.locator('#runButton')).toBeDisabled();
    await page.locator('#imageInput').setInputFiles(nifti('interface-flair.nii'));
    await expect(status).toHaveText(/^FLAIR loaded\W+ready to segment lesions$/);
    await expect(page.locator('#fileInfo')).toContainText('interface-flair.nii');
    await expect(page.locator('#fileInfo')).toContainText('16 × 16 × 16');
    await expect(page.getByRole('button',{name:'Segment lesions',exact:true})).toBeEnabled();
    await page.locator('#folds').selectOption('5');
    await page.locator('#skullStripped').check();
    const advanced = page.locator('#advancedSettings > summary');
    await advanced.tap();
    await expect(page.locator('#folds')).toBeHidden();
    await advanced.tap();
    await expect(page.locator('#folds')).toHaveValue('5');
    await expect(page.locator('#skullStripped')).toBeChecked();
    await expect(page.locator('#cancelButton')).toBeHidden();
    await expect(page.locator('#outputSection')).not.toHaveAttribute('open', '');
  });
  await check('elastix', async page => {
    await expect(page.locator('#runButton')).toBeDisabled();
    await page.locator('#method').selectOption('rigid');
    await page.locator('#advancedSettings > summary').tap();
    await page.locator('#resolutions').fill('2');
    await page.locator('#advancedSettings > summary').tap();
    await page.locator('#advancedSettings > summary').tap();
    await expect(page.locator('#resolutions')).toHaveValue('2');
    await expect(page.locator('#method')).toHaveValue('rigid');
    await page.locator('#movingInput').setInputFiles(nifti('moving.nii'));
    await expect(page.locator('#movingInfo')).toContainText('moving.nii');
    await page.locator('#fixedInput').setInputFiles(nifti('fixed.nii'));
    await expect(page.locator('#runButton')).toBeEnabled();
    await page.locator('#movingInput').setInputFiles({
      name: 'detached.mhd', mimeType: 'text/plain', buffer: Buffer.from('ElementDataFile = image.raw'),
    });
    await expect(page.locator('#statusText')).toContainText('self-contained');
    await expect(page.locator('#movingInfo')).toContainText('moving.nii');
    await expect(page.locator('#runButton')).toBeEnabled();
  });
  await check('syncro', async page => {
    await expect(page.locator('#runButton')).toBeDisabled();
    await expect(page.locator('#results')).not.toHaveAttribute('open','');
    const processing = page.getByText('Processing settings', {exact:true});
    await processing.tap();
    await expect(page.locator('#synthsrBackend')).toHaveValue('webgpu');
    await page.locator('#synthsrBackend').selectOption('wasm');
    await processing.tap();
    await processing.tap();
    await expect(page.locator('#synthsrBackend')).toHaveValue('wasm');
    await processing.tap();
    await page.locator('#movingInput').setInputFiles(nifti('anatomical.nii'));
    await expect(page.locator('#runButton')).toBeEnabled();
    await page.locator('#lesion').setInputFiles(nifti('lesion.nii',0));
    await page.locator('#pathological').setInputFiles(nifti('pathological.nii',30));
    await expect(page.locator('#clearLesion')).toBeVisible();
    await expect(page.locator('#clearPathological')).toBeVisible();
    await page.locator('#inputSection > summary').tap();
    await page.locator('#inputSection > summary').tap();
    await expect(page.locator('#lesionDropZone')).toContainText('lesion.nii');
    await expect(page.locator('#pathologicalDropZone')).toContainText('pathological.nii');
    await page.getByRole('button',{name:'About',exact:true}).tap();
    await expect(page.locator('#info')).toContainText('SynthStrip');
    await page.locator('#info').getByRole('button',{name:'Close',exact:true}).tap();
    await expect(page.locator('#info')).toBeHidden();
  });
  await check('easy-mp2rage', async page => {
    await expect(page.locator('#parameterPanel')).not.toHaveAttribute('open','');
    await page.locator('#taskSel').selectOption('b1only');
    await page.locator('#parameterPanel > summary').tap();
    await expect(page.locator('#mpBlock')).toBeVisible();
    await page.locator('#mp_tr').fill('');
    await expect(page.locator('#saBlock')).toBeVisible();
    await page.locator('#taskSel').selectOption('denoise');
    await expect(page.locator('#parameterPanel')).toBeHidden();
    await page.locator('#file').setInputFiles([nifti('scan_uni.nii'),nifti('scan_inv1.nii',30),nifti('scan_inv2.nii',40)]);
    await expect(page.locator('#run')).toBeEnabled();
    await page.locator('#run').tap();
    await expect(page.locator('#downloads a:visible').first()).toBeVisible({timeout:60000});
    await page.getByRole('button',{name:'About',exact:true}).tap();
    await expect(page.locator('dialog[data-dialog="about"]')).toContainText('MP2RAGE');
    await page.locator('dialog[data-dialog="about"] .nd-app-dialog__close').tap();
    await expect(page.locator('dialog[data-dialog="about"]')).toBeHidden();
    page.once('dialog', dialog => dialog.accept());
    await page.locator('#resetAll').tap();
    await expect(page.locator('#downloads a')).toHaveCount(0);
    await expect(page.locator('#run')).toBeDisabled();
  });
  await check('mri2vid', async page => {
    await page.locator('#pickFiles').setInputFiles(nifti('interface-volume.nii'));
    await expect(page.locator('#optionsPanel')).toBeVisible();
    for (const kind of ['About','Privacy']) {
      await page.getByRole('button',{name:kind,exact:true}).tap();
      const dialog = page.locator(`#${kind.toLowerCase()}Dialog`);
      await expect(dialog).toBeVisible();
      await dialog.locator('.nd-app-dialog__close').tap();
      await expect(dialog).toBeHidden();
    }
  });
  await check('surfannotate', async page => {
    for (const id of ['overlayPanel','annotationPanel','roiPanel','exportPanel']) await expect(page.locator(`#${id}`)).not.toHaveAttribute('open','');
    const obj='v 0 0 0\nv 10 0 0\nv 0 10 0\nv 0 0 10\nf 1 3 2\nf 1 2 4\nf 2 3 4\nf 3 1 4\n';
    await page.locator('#surfaceInput').setInputFiles({name:'interface.obj',mimeType:'text/plain',buffer:Buffer.from(obj)});
    await expect(page.locator('#overlayInput')).toBeEnabled();
    await expect(page.locator('#overlayPanel')).toHaveAttribute('open','');
    await expect(page.locator('#annotationPanel')).toHaveAttribute('open','');
    await expect(page.locator('#exportPanel')).not.toHaveAttribute('open','');
    await page.locator('#overlayPanel > summary').tap();
    await expect(page.locator('#overlayInput')).toBeHidden();
    await page.locator('#overlayPanel > summary').tap();
    await expect(page.locator('#surfaceList')).toContainText('interface.obj');
  });
  await check('dicompare', async page => {
    const toggle = page.locator('button[aria-controls="workflow-compare"]');
    await toggle.focus(); await page.keyboard.press('Enter');
    await expect(toggle).toHaveAttribute('aria-expanded','true');
    await expect(page.locator('#workflow-compare')).toBeVisible();
    await page.keyboard.press('Space');
    await expect(toggle).toHaveAttribute('aria-expanded','false');
    await expect(page.locator('#workflow-compare')).toHaveCount(0);
    const status = page.locator('[data-runtime-status]');
    if (await status.count()) expect(await status.evaluate(node => getComputedStyle(node).position)).toBe('static');
  });
  await check('dicomview', async page => {
    await page.locator('#dicomInput').setInputFiles(dicomSeries({ series: 4, slices: 4 }).map(({ name, mimeType, buffer }) => ({ name, mimeType, buffer })));
    await expect(page.locator('#statusText')).toHaveText('Series 4: test_scan_4 · 1 image', { timeout: 60000 });
    await page.locator('[data-view="header"]').tap();
    await page.locator('#headerFilter').fill('Modality');
    await expect(page.locator('#headerRows tr')).toHaveCount(1);
    await page.locator('#protocolSection > summary').tap();
    await page.locator('#schemaSelect').selectOption({ label: 'UK Biobank' });
    await expect(page.locator('#protocolButton')).toHaveText('Check compliance');
    await page.locator('#protocolSection > summary').tap();
    await expect(page.locator('#schemaSelect')).toBeHidden();
    await page.locator('#protocolSection > summary').tap();
    await expect(page.locator('#schemaSelect')).toHaveValue('UK_Biobank_v1.0');
    await expect(page.locator('#headerFilter')).toHaveValue('Modality');
  });
  await check('spinalcordtoolbox', async page => {
    await page.locator('#fileInput').setInputFiles(nifti('interface-cord.nii'));
    const advanced = page.getByText('Advanced segmentation settings',{exact:true});
    await expect(page.locator('#stepInferenceSection')).not.toHaveClass(/step-disabled/);
    await advanced.tap();
    await page.locator('#thresholdInput').fill('0.2');
    const toggle = page.locator('#stepInferenceSection [data-disclosure-toggle]');
    await toggle.tap(); await expect(page.locator('#thresholdInput')).toBeHidden();
    await toggle.tap(); await expect(page.locator('#thresholdInput')).toHaveValue('0.2');
  });
  await check('degibbs', async page => {
    await expect(page.locator('#statusText')).toHaveText('Drag and drop files', { timeout: 60000 });
    await expect(page.locator('#technicalLog')).toHaveClass(/collapsed/);
    await checkBidsRun(page);
    await page.locator('#imageInput').setInputFiles(dwiSeries());
    await expect(page.locator('#fileInfo')).toContainText('interface-dwi.nii');
    await expect(page.locator('#runButton')).toBeEnabled();
    // Without a sidecar the load sets the default plane; the choice made after it must survive.
    await expect(page.locator('#sliceAxes')).toHaveValue('0,1');
    await page.locator('#sliceAxes').selectOption('0,2');
    const task = page.locator('#taskSection > summary');
    await task.tap();
    await expect(page.locator('#sliceAxes')).toBeHidden();
    await task.tap();
    await expect(page.locator('#sliceAxes')).toHaveValue('0,2');
    await expect(page.locator('#outputSection')).not.toHaveAttribute('open', '');
  });
  await check('hmc', async page => {
    await expect(page.locator('#statusText')).toHaveText('Drag and drop files', { timeout: 60000 });
    await expect(page.locator('#technicalLog')).toHaveClass(/collapsed/);
    await page.locator('#imageInput').setInputFiles(dwiSeries());
    const info = 'interface-dwi.nii · 16×16×16×13';
    await expect(page.locator('#fileInfo')).toHaveText(info);
    await expect(page.locator('#runButton')).toBeEnabled();
    await expect(page.locator('#method')).toHaveValue('gp');
    await page.locator('#method').selectOption('trivial');
    const advanced = page.locator('#advancedSettings > summary');
    await advanced.tap();
    await page.locator('#seed').fill('17');
    await expect(page.locator('#workers')).toHaveValue('2');
    await page.locator('#workers').fill('4');
    await page.locator('#maskInput').setInputFiles(nifti('interface-mask.nii', 1));
    await expect(page.locator('#statusText')).toHaveText('Brain mask loaded');
    await expect(page.locator('#maskField .nd-file-text')).toContainText('interface-mask.nii');
    await advanced.tap();
    await expect(page.locator('#seed')).toBeHidden();
    const task = page.locator('#taskSection > summary');
    await task.tap();
    await expect(page.locator('#method')).toBeHidden();
    await task.tap();
    await expect(page.locator('#method')).toHaveValue('trivial');
    await advanced.tap();
    await expect(page.locator('#seed')).toHaveValue('17');
    await expect(page.locator('#workers')).toHaveValue('4');
    await expect(page.locator('#maskField .nd-file-text')).toContainText('interface-mask.nii');
    await page.locator('#clearMask').tap();
    await expect(page.locator('#maskField .nd-file-text')).toHaveText('Drop a brain mask');
    await expect(page.locator('#clearMask')).toBeHidden();
    const input = page.locator('#inputSection > summary');
    await input.tap();
    await expect(page.locator('#fileInfo')).toBeHidden();
    await input.tap();
    await expect(page.locator('#fileInfo')).toHaveText(info);
    await expect(page.locator('#runButton')).toBeEnabled();
    await expect(page.locator('#outputSection')).not.toHaveAttribute('open', '');
  });
  await check('noddi', async page => {
    await expect(page.locator('#statusText')).toHaveText('Drag and drop files', { timeout: 60000 });
    await expect(page.locator('#technicalLog')).toHaveClass(/collapsed/);
    await checkBidsRun(page);
    await page.locator('#imageInput').setInputFiles(dwiSeries());
    await expect(page.locator('#fileInfo')).toContainText('1×b0, 6×b1000, 6×b2000');
    await expect(page.locator('#noddiNote')).toHaveText('');
    await expect(page.locator('#runButton')).toBeEnabled();
    const advanced = page.locator('#advancedSettings > summary');
    await expect(page.locator('#tensorFit')).toBeHidden();
    await advanced.tap();
    await expect(page.locator('#tensorFit')).toHaveValue('wls');
    await page.locator('#tensorFit').selectOption('ols');
    await advanced.tap();
    await expect(page.locator('#tensorFit')).toBeHidden();
    await advanced.tap();
    await expect(page.locator('#tensorFit')).toHaveValue('ols');
    await expect(page.locator('#outputSection')).not.toHaveAttribute('open', '');
  });
  // dwidenoise has no option to set: Patch2Self takes only the DWI and its bval.
  await check('dwidenoise', async page => {
    await expect(page.locator('#statusText')).toHaveText('Drag and drop files', { timeout: 60000 });
    await expect(page.locator('#technicalLog')).toHaveClass(/collapsed/);
    await page.locator('#imageInput').setInputFiles(dwiSeries());
    const info = 'interface-dwi.nii · 16×16×16×13 · 1 b0, 12 weighted · bval, bvec';
    await expect(page.locator('#fileInfo')).toHaveText(info);
    await expect(page.locator('#runButton')).toBeEnabled();
    const input = page.locator('#inputSection > summary');
    await input.tap();
    await expect(page.locator('#fileInfo')).toBeHidden();
    await input.tap();
    await expect(page.locator('#fileInfo')).toHaveText(info);
    const task = page.locator('#taskSection > summary');
    await task.tap();
    await expect(page.locator('#runButton')).toBeHidden();
    await task.tap();
    await expect(page.locator('#runButton')).toBeEnabled();
    await checkBidsRun(page);
    await expect(page.locator('#runButton')).toBeEnabled();
    await expect(page.locator('#outputSection')).not.toHaveAttribute('open', '');
  });
  await check('n4', async page => {
    await expect(page.locator('#statusText')).toHaveText('Drag and drop files', { timeout: 60000 });
    await expect(page.locator('#technicalLog')).toHaveClass(/collapsed/);
    await page.locator('#imageInput').setInputFiles(dwiSeries());
    await expect(page.locator('#fileInfo')).toHaveText('interface-dwi.nii · 16×16×16×13 · bval, bvec');
    await expect(page.locator('#modeNote')).toHaveText('DWI: the field is fitted to the b0 volume.');
    await expect(page.locator('#runButton')).toBeEnabled();
    // The optional mask chosen in Advanced settings must survive closing that section and its parent.
    const advanced = page.locator('#advancedSettings > summary');
    await expect(page.locator('#maskInput')).toBeHidden();
    await advanced.tap();
    await page.locator('#maskInput').setInputFiles(nifti('interface-mask.nii', 1));
    await expect(page.locator('#maskInfo')).toHaveText('interface-mask.nii · 4096 voxels');
    await advanced.tap();
    await expect(page.locator('#maskInfo')).toBeHidden();
    await advanced.tap();
    await expect(page.locator('#maskInfo')).toHaveText('interface-mask.nii · 4096 voxels');
    const task = page.locator('#taskSection > summary');
    await task.tap();
    await expect(page.locator('#maskInfo')).toBeHidden();
    await task.tap();
    await expect(page.locator('#maskInfo')).toHaveText('interface-mask.nii · 4096 voxels');
    await checkBidsRun(page);
    await expect(page.locator('#runButton')).toBeEnabled();
    await expect(page.locator('#outputSection')).not.toHaveAttribute('open', '');
  });
  await check('sdc', async page => {
    await expect(page.locator('#statusText')).toHaveText('Drag and drop files', { timeout: 60000 });
    await expect(page.locator('#technicalLog')).toHaveClass(/collapsed/);
    const sidecar = (name, direction) => ({ name, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ PhaseEncodingDirection: direction, TotalReadoutTime: 0.04 })) });
    await page.locator('#imageInput').setInputFiles([
      ...dwiSeries('sub-01_dir-AP_dwi'),
      sidecar('sub-01_dir-AP_dwi.json', 'j-'),
      nifti('sub-01_dir-PA_epi.nii'),
      sidecar('sub-01_dir-PA_epi.json', 'j'),
    ]);
    await expect(page.locator('#fileInfo')).toHaveText('Image 1: sub-01_dir-AP_dwi.nii · j- · b = 0 mean of 1/13');
    await expect(page.locator('#runButton')).toBeEnabled();
    // The field reference chosen after loading must survive closing the section.
    await page.locator('#reference').selectOption({ label: 'sub-01_dir-PA_epi.nii' });
    const task = page.locator('#taskSection > summary');
    await task.tap();
    await expect(page.locator('#reference')).toBeHidden();
    await task.tap();
    await expect(page.locator('#reference')).toHaveValue('0');
    await expect(page.locator('#fileInfo')).toHaveText('Image 1: sub-01_dir-PA_epi.nii · j');
    await expect(page.locator('#outputSection')).not.toHaveAttribute('open', '');
  });
  await check('dwicorrect', async page => {
    await expect(page.locator('#statusText')).toHaveText('Drag and drop files', { timeout: 60000 });
    await expect(page.locator('#technicalLog')).toHaveClass(/collapsed/);
    const sidecar = { name: 'sub-01_dir-AP_dwi.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ PhaseEncodingDirection: 'j-', TotalReadoutTime: 0.05 })) };
    await page.locator('#imageInput').setInputFiles([...dwiSeries('sub-01_dir-AP_dwi'), sidecar]);
    await expect(page.locator('#fileInfo')).toHaveText('sub-01_dir-AP_dwi.nii');
    await expect(page.locator('#runButton')).toBeEnabled();
    // 13 volumes are too few for 3dSHORE, and without a reverse b0 there is no field.
    await expect(page.locator('#model')).toHaveValue('gp');
    await expect(page.locator('#fieldSource')).toHaveValue('none');
    // The sidecar has no multiband factor, so the input section asks; the answer must survive closing it.
    await page.locator('#multiband').fill('2');
    const input = page.locator('#inputSection > summary');
    await input.tap();
    await expect(page.locator('#multiband')).toBeHidden();
    await input.tap();
    await expect(page.locator('#multiband')).toHaveValue('2');
    const advanced = page.locator('#advancedSettings > summary');
    await advanced.tap();
    await page.locator('#iterations').fill('3');
    await advanced.tap();
    await expect(page.locator('#iterations')).toBeHidden();
    await advanced.tap();
    await expect(page.locator('#iterations')).toHaveValue('3');
    await expect(page.locator('#outlierType')).toHaveValue('both');
    const task = page.locator('#taskSection > summary');
    await task.tap();
    await expect(page.locator('#iterations')).toBeHidden();
    await task.tap();
    await expect(page.locator('#iterations')).toHaveValue('3');
    await expect(page.locator('#outputSection')).not.toHaveAttribute('open', '');
  });
  await check('pipeline-builder', async page => {
    await expect(page.locator('#statusText')).toContainText('operations from the Neurodesk catalog', { timeout: 60000 });
    await expect(page.locator('#technicalLog')).toHaveClass(/collapsed/);
    await page.getByRole('combobox', { name: 'Input', exact: true }).selectOption('t1-segmentation');
    await expect(page.locator('[data-neurodesk-examples]')).toHaveAttribute('data-example-state', 'ready', { timeout: 60000 });
    await expect(page.locator('#validationSummary')).toHaveText('Valid · 3 steps.');
    await page.getByRole('button', { name: 'brain', exact: true }).tap();
    const parameters = page.locator('#stepEditor details');
    await parameters.locator('summary').tap();
    await page.locator('#param-param_threshold').fill('0.3');
    await page.locator('#param-param_threshold').press('Enter');
    await expect(parameters).toHaveAttribute('open', '');
    const step = page.locator('#stepSection > summary');
    await step.tap();
    await expect(page.locator('#param-param_threshold')).toBeHidden();
    await step.tap();
    await expect(page.locator('#param-param_threshold')).toHaveValue('0.3');
    const pending = page.waitForEvent('download');
    await page.locator('#runButton').tap();
    const download = await pending;
    expect(download.suggestedFilename()).toBe('t1-segmentation.workflow.json');
    const template = JSON.parse(await readFile(join(repoRoot, 'apps/pipeline-builder/src/workflows/t1-segmentation.workflow.json'), 'utf8'));
    template.steps.brain.inputs.param_threshold = { constant: 0.3 };
    expect(JSON.parse(await readFile(await download.path(), 'utf8'))).toEqual(template);
  });
} finally { await browser.close(); await site.close(); }
if (failures.length) throw new Error(failures.join('\n'));
