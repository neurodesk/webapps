import { test, expect } from '@playwright/test';
import { dicomSeries } from '../../../test-utils/dicom-fixture.mjs';

test('cancelling DICOM import retains the prior scan and allows another upload', async ({ page }) => {
  await page.goto('./');
  const input = page.locator('#imageInput');
  await input.setInputFiles(new URL('../test/fixtures/validation.nii.gz', import.meta.url).pathname);
  await expect(page.locator('#processButton')).toBeEnabled();
  let intercepted;
  const request = new Promise(resolve => { intercepted = resolve; });
  await page.route('**/*dcm2niix*.wasm', route => { intercepted(route); });
  await input.setInputFiles(dicomSeries());
  const held = await request;
  await page.locator('#cancelBtn').click();
  await held.abort();
  await expect(page.locator('#fileInfo')).toContainText('validation.nii.gz');
  await expect(page.locator('#processButton')).toBeEnabled();
  await page.unroute('**/*dcm2niix*.wasm');
  await input.setInputFiles(dicomSeries());
  await expect(page.locator('#fileInfo')).toContainText('16 × 16 × 4', { timeout: 60000 });
});

test('one compact picker imports DICOM slices, selects series, and returns to NIfTI', async ({ page }) => {
  await page.goto('./');
  const input = page.locator('#imageInput');
  await input.setInputFiles([...dicomSeries({ extension: '' }), ...dicomSeries({ series: 2, slices: 6, extension: '.IMA' })]);
  await expect(page.locator('#seriesSelect')).toBeVisible({ timeout: 60000 });
  await expect(page.locator('#seriesSelect option')).toHaveCount(2);
  const names = await page.locator('#seriesSelect option').allTextContents();
  await page.locator('#seriesSelect').selectOption({ label: names.find(name => name.includes('test_scan_1')) });
  await expect(page.locator('#fileInfo')).toContainText('16 × 16 × 4');
  await page.locator('#seriesSelect').selectOption({ label: names.find(name => name.includes('test_scan_2')) });
  await expect(page.locator('#fileInfo')).toContainText('16 × 16 × 6');
  await expect(page.locator('#processButton')).toBeEnabled();
  await input.setInputFiles({ name: 'invalid.nii', mimeType: 'application/octet-stream', buffer: Buffer.from('invalid') });
  await expect(page.locator('#statusText')).toHaveClass(/\berror\b/);
  await expect(page.locator('#seriesSelect')).toBeVisible();
  await expect(page.locator('#fileInfo')).toContainText('16 × 16 × 6');
  await input.setInputFiles(new URL('../test/fixtures/validation.nii.gz', import.meta.url).pathname);
  await expect(page.locator('#fileInfo')).toContainText('validation.nii.gz');
  await expect(page.locator('#seriesSelect')).toBeHidden();
  await input.setInputFiles({ name: 'invalid.dcm', mimeType: 'application/dicom', buffer: Buffer.from('invalid') });
  await expect(page.locator('#statusText')).toContainText(/No images produced|failed/i, { timeout: 60000 });
  await expect(page.locator('#fileInfo')).toContainText('validation.nii.gz');
  await expect(page.locator('#processButton')).toBeEnabled();
});

for (const width of [390, 1440]) {
  test(`input stays compact at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('./');
    const picker = page.locator('#imageInput');
    await expect(picker).toBeVisible();
    expect((await picker.boundingBox()).height).toBeLessThanOrEqual(48);
    expect((await page.locator('#inputSection').boundingBox()).height).toBeLessThanOrEqual(220);
    await expect(page.locator('#exampleSelect')).toBeVisible();
    await expect(page.locator('#outputSection')).not.toHaveAttribute('open', '');
    if(width===390) {
      for(const selector of ['#modality','#exampleSelect','#processButton']) {
        const field=page.locator(selector);
        expect((await field.boundingBox()).height).toBeGreaterThanOrEqual(44);
      }
    }
  });
}

test('shared examples load through the image workflow and preserve input on failure', async ({ page }) => {
  const { readFile } = await import('node:fs/promises');
  const examples = JSON.parse(await readFile(new URL('../examples.json', import.meta.url), 'utf8'));
  const { fileURLToPath } = await import('node:url');
  const fixture = fileURLToPath(new URL('../test/fixtures/validation.nii.gz', import.meta.url));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('./');
  await expect(page.locator('#exampleSelect option')).toHaveText(['Choose an example…', ...examples.map(example => example.label)]);
  await expect(page.locator('#exampleBtn')).toHaveCount(0);
  for (const id of ['t1-head', 'brain-ct']) {
    const example = examples.find(example => example.id === id);
    await page.route(example.files[0].url, route => route.fulfill({ path: fixture, contentType: 'application/octet-stream' }));
    await page.locator('#exampleSelect').selectOption(id);
    await expect(page.locator('#fileInfo')).toContainText(example.files[0].name);
    await expect(page.locator('#processButton')).toBeEnabled();
    await expect(page.locator('#modality')).toHaveValue('mr'); // Both responses contain the same positive fixture, regardless of filename.
    await expect(page.locator('#outputTab')).toBeHidden();
  }
  await page.locator('#synthesisSection > summary').click();
  await expect(page.locator('#modality')).toBeHidden();
  await page.locator('#synthesisSection > summary').click();
  await expect(page.locator('#exampleSelect')).toHaveValue('');
  const failedExample = examples.find(example => example.id === 't2-head');
  await page.route(failedExample.files[0].url, route => route.fulfill({ status: 503, body: 'Unavailable' }));
  await page.locator('#exampleSelect').selectOption('t2-head');
  await expect(page.locator('#statusText')).toContainText('Could not download');
  await expect(page.locator('#exampleSelect')).toHaveValue('');
  await expect(page.locator('#fileInfo')).toContainText('CT_Philips.nii.gz');
  await expect(page.locator('#modality')).toHaveValue('mr');
  await expect(page.locator('#processButton')).toBeEnabled();
  await expect(page.locator('#outputSection')).not.toHaveAttribute('open', '');
  await page.locator('#imageInput').setInputFiles(fixture);
  await expect(page.locator('#exampleSelect')).toHaveValue('');
});

 test('detects modality from scaled voxels and allows an override', async ({ page }) => {
  const { writeVolume } = await import('../src/volume.js');
  const dims = [4,4,4], affine = [[1,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,0,1]];
  const data = Float32Array.from({length:64},(_,i)=>i);
  const bytes = writeVolume({data,dims,affine});
  new DataView(bytes).setFloat32(116,-1024,true); // Header scaling makes unsigned-looking samples negative HU.
  await page.goto('./');
  await page.locator('#processingSettings > summary').click();
  await expect(page.locator('#backend')).toHaveValue('webgpu');
  await expect(page.locator('#outputTab')).toBeHidden();
  await page.locator('#imageInput').setInputFiles({name:'scan.nii',mimeType:'application/octet-stream',buffer:Buffer.from(bytes)});
  await expect(page.locator('#processButton')).toBeEnabled();
  await expect(page.locator('#modality')).toHaveValue('ct');
  await page.locator('#modality').selectOption('mr');
  await expect(page.locator('#modality')).toHaveValue('mr');
  await expect(page.locator('.privacy')).toHaveCount(0);
});
