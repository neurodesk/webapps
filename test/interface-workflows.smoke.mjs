#!/usr/bin/env node
import { join } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { loadAppsRegistry, repoRoot } from '../scripts/lib/apps-registry.mjs';
import { serveSite } from '../test-utils/serve-site.mjs';

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
    await page.locator('#input').setInputFiles(nifti('anatomical.nii'));
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
  await check('dicom2vid', async page => {
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
} finally { await browser.close(); await site.close(); }
if (failures.length) throw new Error(failures.join('\n'));
