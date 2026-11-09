import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';

const reference = JSON.parse(await readFile(new URL('../validation/neurom-reference.json', import.meta.url), 'utf8'));

// The installed desktop app measures NeuroM's Neuron.swc test morphology (the harness's
// image fixture is not a reconstruction) and its table holds NeuroM's numbers.
export async function verifyOffline(page, { download }) {
  const fixture = fileURLToPath(new URL('fixtures/neurom/Neuron.swc', import.meta.url));
  await page.locator('#swcInput').setInputFiles(fixture);
  await expect(page.locator('#runButton')).toBeEnabled({ timeout: 60000 });
  await page.locator('#runButton').click();
  await expect(page.locator('#statusText')).toHaveText('Neuron.swc measured', { timeout: 60000 });
  const result = await download('#resultList .nd-volume-toggle:has-text("Morphometrics table") .nd-download-btn');
  assert.equal(result.filename, 'Neuron_morphometrics.csv');
  const [header, all] = result.bytes.toString('utf8').trim().split('\n').map(line => line.split(','));
  const length = Number(all[header.indexOf('total_length_um')]);
  const expected = reference.morphologies.find(m => m.file === 'Neuron.swc').features.all.totalLength;
  assert.ok(Math.abs(length - expected) / expected < 1e-6, `${length} vs NeuroM ${expected}`);
  return { filename: result.filename, totalLengthUm: length };
}
