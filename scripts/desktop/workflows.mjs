import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { readFile, readdir, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { expect } from '@playwright/test';
import { verifyMuscleMapFullPipeline, createSyntheticMuscleMapNifti } from '../../test/musclemap-full-pipeline-smoke.mjs';

export const workflowApps = ['musclemap', 'vesselboost', 'spinalcordtoolbox', 'calmar', 'qsmbly', 'seedseg', 'dicompare', 'deface', 'easy-mp2rage', 'niimath', 'dicom2vid', 'browserqc', 'surfannotate', 'zarro', 'synthsr', 'synthseg', 'syncro', 'dwi2trx', 'edgereg', 'greedy', 'ants', 'brain2print', 'topofit', 'fireants'];

export async function verifyWorkflow(id, page, { root, resources, desktop }) {
  const fixture = join(root, 'exes/synthseg/test/fixtures/small.nii.gz');
  const download = async selector => {
    const count = await desktop.evaluate(() => globalThis.neurodeskOffline.downloads.length);
    await page.locator(selector).evaluate(element => {
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        if (parent.tagName === 'DETAILS') parent.open = true;
        if (parent.matches('[data-disclosure]')) {
          const toggle = parent.querySelector('[data-disclosure-toggle]');
          if (toggle?.getAttribute('aria-expanded') === 'false') toggle.click();
        }
      }
    });
    await page.locator(selector).click();
    await expect.poll(() => desktop.evaluate((_electron, count) => globalThis.neurodeskOffline.downloads[count]?.state, count), { timeout: 60000 }).toBe('completed');
    const item = await desktop.evaluate((_electron, count) => globalThis.neurodeskOffline.downloads[count], count);
    const bytes = await readFile(item.path);
    assert.ok(bytes.length > 0, 'Output must not be empty');
    return { bytes, filename: item.filename };
  };
  const nifti = data => {
    const bytes = data.bytes[0] === 31 && data.bytes[1] === 139 ? gunzipSync(data.bytes) : data.bytes;
    assert.ok([348, 540].includes(bytes.readInt32LE(0)), 'Output must have a NIfTI header');
    assert.ok(bytes.length > 352, 'Output must contain image data');
    return { filename: data.filename, bytes: data.bytes.length };
  };
  if (id === 'musclemap') return verifyMuscleMapFullPipeline(page, page.url());
  if (['vesselboost', 'spinalcordtoolbox', 'seedseg'].includes(id)) {
    await page.locator(id === 'seedseg' ? '#unifiedFiles' : '#fileInput').setInputFiles(id === 'seedseg' ? { name: 'scan_T1w.nii.gz', mimeType: 'application/gzip', buffer: await readFile(fixture) } : fixture);
    if (id === 'vesselboost') {
      for (const selector of ['#skipDownsampleBtn', '#skipN4Btn', '#skipDenoiseBtn']) {
        await expect(page.locator(selector)).toBeEnabled({ timeout: 60000 });
        await page.locator(selector).evaluate(button => button.click());
      }
    }
    await expect(page.locator('#runSegmentation')).toBeEnabled({ timeout: 60000 });
    await page.locator('#runSegmentation').click();
    const stage = id === 'seedseg' ? 'consensus' : 'segmentation';
    await page.waitForFunction(stage => Boolean(window.app?.inferenceExecutor?.getResult(stage)?.file), stage, { timeout: 600000 });
    const result = await page.evaluate(async stage => {
      const file = window.app.inferenceExecutor.getResult(stage).file;
      return { bytes: file.size, filename: file.name };
    }, stage);
    assert.ok(result.bytes > 352);
    return result;
  }
  if (['ants', 'greedy', 'edgereg', 'fireants'].includes(id)) {
    if (id === 'ants' || id === 'fireants') {
      await expect(page.locator('#runButton')).toBeEnabled({ timeout: 120000 });
      await page.locator('#runButton').click();
    }
    await expect(page.locator('#statusText')).toContainText('Registration complete', { timeout: 900000 });
    return nifti(await download('#resultList button:has-text("Download") >> nth=0'));
  }
  if (id === 'dicompare') {
    const worker = (await readdir(join(resources, 'site/dicompare/assets'))).find(name => /^pyodide\.worker-.*\.js$/.test(name));
    assert.ok(worker, 'Compiled Python worker must be included');
    return page.evaluate(worker => new Promise((resolve, reject) => {
      const instance = new Worker(new URL(`assets/${worker}`, location.href), { type: 'module' });
      const timeout = setTimeout(() => { instance.terminate(); reject(new Error('Offline Python initialization timed out')); }, 120000);
      instance.onerror = error => { clearTimeout(timeout); instance.terminate(); reject(new Error(error.message)); };
      instance.onmessage = ({ data }) => {
        if (data.type === 'error') { clearTimeout(timeout); instance.terminate(); reject(new Error(JSON.stringify(data.error))); }
        if (data.id === 'offline-python' && data.type === 'success') { clearTimeout(timeout); instance.terminate(); resolve(data.payload); }
      };
      instance.postMessage({ id: 'offline-python', type: 'initialize' });
    }), worker);
  }
  if (['synthsr', 'synthseg'].includes(id)) {
    await page.locator('#imageInput').setInputFiles(fixture);
    await expect(page.locator('#processButton')).toBeEnabled({ timeout: 60000 });
    await page.locator('#processButton').click();
    const selector = id === 'synthseg' ? '#resultList button:has-text("Download") >> nth=0' : '#saveBtn';
    await expect(page.locator(selector)).toBeEnabled({ timeout: 600000 });
    return nifti(await download(selector));
  }
  if (id === 'niimath') {
    await page.locator('#niftiInput').setInputFiles(fixture);
    await page.locator('#command').fill('-add 1');
    await expect(page.locator('#processButton')).toBeEnabled({ timeout: 60000 });
    await page.locator('#processButton').click();
    await expect(page.locator('#outputSection')).toHaveAttribute('open', '', { timeout: 60000 });
    await expect(page.locator('#saveButton')).toBeVisible({ timeout: 60000 });
    return nifti(await download('#saveButton'));
  }
  if (id === 'easy-mp2rage') {
    const bytes = createSyntheticMuscleMapNifti();
    await page.locator('#taskSel').selectOption('denoise');
    await page.locator('#file').setInputFiles(['uni', 'inv1', 'inv2'].map(name => ({ name: `scan_${name}.nii`, mimeType: 'application/octet-stream', buffer: bytes })));
    await page.locator('#run').click();
    await expect(page.locator('#downloads a').first()).toBeVisible({ timeout: 60000 });
    const result = await download('#downloads a >> nth=0');
    assert.equal(result.bytes.readUInt16LE(0), 0x4b50);
    return { filename: result.filename, bytes: result.bytes.length };
  }
  if (id === 'surfannotate') {
    await page.locator('#surfaceInput').setInputFiles({ name: 'tetrahedron.obj', mimeType: 'text/plain', buffer: Buffer.from('v 0 0 0\nv 10 0 0\nv 0 10 0\nv 0 0 10\nf 1 3 2\nf 1 2 4\nf 2 3 4\nf 3 1 4\n') });
    await expect(page.locator('#overlayInput')).toBeEnabled({ timeout: 60000 });
    await expect(page.locator('#surfaceList')).toContainText('tetrahedron.obj');
    await page.evaluate(() => {
      const { session } = window.__surfannotate;
      for (const vertex of [0, 1, 2]) session.addClick(vertex);
      session.closePath();
      window.__surfannotateUi.runFill(-1);
    });
    const result = await download('#exportLabel');
    const lines = result.bytes.toString('utf8').trim().split('\n');
    assert.ok(Number(lines[1]) > 0, 'Surface annotation must contain vertices');
    return { loadedSurface: 'tetrahedron.obj', filename: result.filename, vertices: Number(lines[1]) };
  }
  if (id === 'qsmbly') {
    const result = await page.evaluate(async () => {
      const qsm = await import(new URL('wasm/qsm_wasm.js', location.href).href);
      await qsm.default();
      const values = qsm.calculate_swi_wasm(new Float64Array(4096), new Float64Array(4096).fill(100), new Uint8Array(4096).fill(1), 16, 16, 16, 1, 1, 1, 2, 2, 2, 2, 4);
      return { voxels: values.length, min: Math.min(...values), max: Math.max(...values) };
    });
    assert.equal(result.voxels, 4096);
    assert.equal(result.min, 100);
    assert.equal(result.max, 100);
    return result;
  }
  if (id === 'dicom2vid') {
    await page.locator('#pickFiles').setInputFiles(fixture);
    await expect(page.locator('#generate')).toBeEnabled({ timeout: 60000 });
    await page.locator('#generate').click();
    await expect(page.locator('#downloadLink')).toBeVisible({ timeout: 120000 });
    const result = await download('#downloadLink');
    assert.ok(result.bytes.length > 1000);
    return { filename: result.filename, bytes: result.bytes.length };
  }
  if (id === 'zarro') {
    const folder = await mkdtemp(join(tmpdir(), 'offline-zarr-'));
    try {
      await mkdir(join(folder, '0'));
      await writeFile(join(folder, '.zgroup'), JSON.stringify({ zarr_format: 2 }));
      await writeFile(join(folder, '.zattrs'), JSON.stringify({ multiscales: [{ version: '0.4', axes: ['z', 'y', 'x'].map(name => ({ name, type: 'space', unit: 'micrometer' })), datasets: [{ path: '0', coordinateTransformations: [{ type: 'scale', scale: [1, 1, 1] }] }] }] }));
      await writeFile(join(folder, '0/.zarray'), JSON.stringify({ zarr_format: 2, shape: [16, 16, 16], chunks: [16, 16, 16], dtype: '<u2', compressor: null, fill_value: 0, order: 'C', filters: null }));
      const bytes = Buffer.alloc(8192);
      for (let i = 0; i < 4096; i++) bytes.writeUInt16LE(i, i * 2);
      await writeFile(join(folder, '0/0.0.0'), bytes);
      const url = await desktop.evaluate(async (_electron, folder) => globalThis.neurodeskOffline.mountDirectory(folder), folder);
      await page.goto(`${new URL(page.url()).origin}/zarro/?source=custom&url=${encodeURIComponent(url)}`);
      await page.locator('#toolsPanel').evaluate(panel => { panel.open = true; });
      await expect(page.locator('#downloadNifti')).toBeEnabled({ timeout: 120000 });
      return nifti(await download('#downloadNifti'));
    } finally { await rm(folder, { recursive: true, force: true }); }
  }
  if (id === 'calmar') {
    await page.locator('#structuralFileInput').setInputFiles(fixture);
    await expect(page.locator('#runBrainExtractionButton')).toBeEnabled({ timeout: 60000 });
    await page.locator('#runBrainExtractionButton').evaluate(button => button.click());
    await expect(page.locator('#downloadBrainMaskButton')).toBeEnabled({ timeout: 600000 });
    await page.locator('#downloadBrainMaskButton').evaluate(button => { for (let parent = button.parentElement; parent; parent = parent.parentElement) if (parent.tagName === 'DETAILS') parent.open = true; });
    return nifti(await download('#downloadBrainMaskButton'));
  }
  if (id === 'deface') {
    await expect(page.locator('#applyBtn')).toBeEnabled({ timeout: 120000 });
    await page.locator('#applyBtn').click();
    await expect(page.locator('#saveBtn')).toBeEnabled({ timeout: 300000 });
    await page.locator('#outputSection').evaluate(section => { section.open = true; });
    return nifti(await download('#saveBtn'));
  }
  if (id === 'browserqc') {
    await page.locator('#niftiInput').setInputFiles(fixture);
    await expect(page.locator('#saveBtn')).toBeEnabled({ timeout: 600000 });
    await page.locator('#resultsSection').evaluate(section => { section.open = true; });
    const result = await download('#saveBtn');
    assert.ok(result.bytes.length > 50);
    return { filename: result.filename, bytes: result.bytes.length };
  }
  if (id === 'brain2print') {
    await expect(page.locator('#segmentButton')).toBeEnabled({ timeout: 120000 });
    await page.locator('#segmentButton').click();
    await expect(page.locator('#meshButton')).toBeEnabled({ timeout: 600000 });
    await page.locator('#meshButton').click();
    await expect(page.locator('#statusText')).toContainText('closed manifold', { timeout: 300000 });
    const result = await download('#downloadButton');
    const triangles = result.bytes.readUInt32LE(80);
    assert.equal(result.bytes.length, 84 + 50 * triangles);
    assert.ok(triangles > 0);
    return { filename: result.filename, triangles };
  }
  if (id === 'dwi2trx') {
    await expect(page.locator('#maskFitBtn')).toBeEnabled({ timeout: 120000 });
    await page.locator('#maskFitBtn').click();
    await expect(page.locator('#saveMapsBtn')).toBeEnabled({ timeout: 600000 });
    const result = await download('#saveMapsBtn');
    await page.locator('#trackingSection').evaluate(section => { section.open = true; });
    await page.locator('#trackBtn').click();
    await expect(page.locator('#saveBtn')).toBeEnabled({ timeout: 300000 });
    const tractogram = await download('#saveBtn');
    assert.equal(tractogram.bytes.readUInt16LE(0), 0x4b50, 'TRX must be a ZIP archive');
    return { filename: result.filename, bytes: result.bytes.length, tractogram: tractogram.filename, tractogramBytes: tractogram.bytes.length };
  }
  if (id === 'syncro') {
    const manifest = JSON.parse(await readFile(join(resources, 'manifest.json')));
    const template = Object.entries(manifest.assets).find(([url]) => url.endsWith('/reg/moving/t1_brain.nii.gz'));
    assert.ok(template, 'The real registration example must be packaged');
    await page.locator('#input').setInputFiles({ name: 't1_brain.nii.gz', mimeType: 'application/gzip', buffer: await readFile(join(resources, template[1].path)) });
    await expect(page.locator('#runButton')).toBeEnabled({ timeout: 60000 });
    await page.locator('#runButton').click();
    await expect(page.locator('#download')).toBeEnabled({ timeout: 900000 });
    const result = await download('#download');
    assert.equal(result.bytes.readUInt16LE(0), 0x4b50);
    return { filename: result.filename, bytes: result.bytes.length };
  }
  if (id === 'topofit') {
    await page.locator('#imageInput').setInputFiles(fixture);
    await expect(page.locator('#runButton')).toBeEnabled({ timeout: 60000 });
    await page.locator('#runButton').click();
    const selector = '#resultList button:has-text("Download") >> nth=0';
    await expect(page.locator(selector)).toBeEnabled({ timeout: 900000 });
    const result = await download(selector);
    return { filename: result.filename, bytes: result.bytes.length };
  }
  throw new Error(`No offline workflow test registered for ${id}`);
}
