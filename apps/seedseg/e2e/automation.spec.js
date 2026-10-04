import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readNifti } from '../../../packages/components/src/file-io/NiftiUtils.js';
import { createProstateFixture } from '../test/prostate-fixture.mjs';

const image = createProstateFixture();

async function runEnsemble(page) {
  await page.goto('/');
  await page.waitForFunction(() => Boolean(globalThis.neurodeskAutomation));
  await page.locator('#neurodesk-input-transfer').setInputFiles({ name: 'synthetic-prostate-t1.nii', mimeType: 'application/x-nifti', buffer: image });
  await page.evaluate(() => neurodeskAutomation.dispatch('adopt', { role: 'image' }));
  await page.evaluate(() => neurodeskAutomation.dispatch('start', { operation: 'segment' }));
  await expect.poll(() => page.evaluate(async () => (await neurodeskAutomation.dispatch('snapshot')).state), { timeout: 540000 }).toMatch(/succeeded|failed/);
  return page.evaluate(() => neurodeskAutomation.dispatch('snapshot'));
}

async function downloadRow(page, row) {
  const waiting = page.waitForEvent('download');
  await row.locator('.download-btn').click();
  const download = await waiting;
  return { name: download.suggestedFilename(), bytes: await readFile(await download.path()) };
}

test('real SeedSeg ensemble completes on a synthetic prostate transport fixture', async ({ page }) => {
  test.setTimeout(600000);
  const snapshot = await runEnsemble(page);
  expect(snapshot.error).toBeUndefined();
  expect(snapshot.state).toBe('succeeded');
  expect(snapshot.report.inputs.image[0].sha256).toBe(createHash('sha256').update(image).digest('hex'));
  expect(snapshot.report.provenance.models).toHaveLength(4);
  expect(Object.values(snapshot.report.artifacts).filter(artifact => artifact.role === 'probability')).toHaveLength(5);
  for (const [id, artifact] of Object.entries(snapshot.report.artifacts)) {
    const waiting = page.waitForEvent('download');
    await page.evaluate(artifactId => neurodeskAutomation.dispatch('download', { artifactId }), id);
    const bytes = await readFile(await (await waiting).path());
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(artifact.sha256);
    const volume = await readNifti(bytes);
    expect(volume.dims).toEqual([64, 64, 32]);
    expect(volume.data.every(value => Number.isFinite(value) && value >= 0 && value <= 1)).toBe(true);
    if (artifact.role === 'markers') expect(volume.data.every(value => value === 0 || value === 1)).toBe(true);
  }
  const directory = join(process.env.TMPDIR || process.env.RUNNER_TEMP, 'neurodesk-seedseg-automation');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'report.json'), JSON.stringify({ validation: 'Synthetic transport fixture; no clinical accuracy claim.', report: snapshot.report }, null, 2));
});

test('the consensus mask can be corrected in the viewer and downloads edited', async ({ page }) => {
  test.setTimeout(600000);
  expect((await runEnsemble(page)).state).toBe('succeeded');
  const row = page.locator('#stage-item-consensus');
  const label = row.locator('.stage-btn');
  const edit = row.getByRole('button', { name: 'Edit', exact: true });
  const editor = page.locator('nd-mask-editor');
  const original = await downloadRow(page, row);

  await edit.click();
  await expect(editor).toBeVisible();
  await expect(page.locator('#statusText')).toHaveText('Editing Consensus. Left-drag paints; Apply keeps the changes.');
  await expect(edit).toBeDisabled();
  await editor.getByRole('button', { name: 'Cancel' }).click();
  await expect(editor).toBeHidden();
  await expect(label).toHaveText('Consensus');
  await expect(edit).toBeEnabled();
  expect((await downloadRow(page, row)).bytes.equals(original.bytes)).toBe(true);

  await page.locator('.view-tab[data-view="axial"]').click();
  await edit.click();
  await expect(editor).toBeVisible();
  const box = await page.locator('#gl1').boundingBox();
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(centre.x - 60, centre.y);
  await page.mouse.down();
  await page.mouse.move(centre.x + 60, centre.y, { steps: 12 });
  await page.mouse.up();
  await editor.getByRole('button', { name: 'Apply' }).click();
  await expect(editor).toBeHidden();
  await expect(label).toHaveText('Consensus (edited)');
  await expect(page.locator('#statusText')).toHaveText('Ready');

  const edited = await downloadRow(page, row);
  expect(edited.name).toBe(original.name);
  const header = new DataView(edited.bytes.buffer, edited.bytes.byteOffset, edited.bytes.byteLength);
  expect(header.getInt16(70, true)).toBe(2);
  const before = await readNifti(original.bytes);
  const after = await readNifti(edited.bytes);
  expect(after.dims).toEqual([64, 64, 32]);
  expect(after.data.some((value, index) => value !== before.data[index])).toBe(true);

  await edit.click();
  await expect(editor).toBeVisible();
  await page.locator('#clearResults').click();
  await expect(editor).toBeHidden();
  await expect(row).toHaveCount(0);
});
