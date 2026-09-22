import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const golden = {
  enigma: fileURLToPath(new URL('../../../exes/nii2tvx/test/expected-examples-enigma.tsv', import.meta.url)),
  hcp1065: fileURLToPath(new URL('../../../exes/nii2tvx/test/expected-examples.tsv', import.meta.url)),
};

test('app boots with the shared bar and the information actions', async ({ page }) => {
  await page.goto('./');
  await expect(page.locator('#controls')).toBeVisible();
  const bar = page.locator('.nd-app-bar:visible');
  await expect(bar).toHaveCount(1);
  for (const name of ['About', 'Cite', 'Privacy']) {
    await expect(bar.getByRole('button', { name, exact: true })).toBeVisible();
  }
  await expect(page.locator('#controls > #aboutBtn')).toBeHidden();
  await bar.getByRole('button', { name: 'About', exact: true }).click();
  await expect(page.locator('#infoDialog')).toContainText('ENIGMA Symmetric White Matter Tractography Atlas');
  await page.locator('#infoDialog').getByRole('button', { name: 'Close' }).click();
  await bar.locator('[data-neurodesk-theme-toggle]').click();
  await expect(page.locator('html')).toHaveAttribute('data-neurodesk-theme', 'light');
});

test('About explains the sample-versus-measurement distinction and points at the CLI', async ({ page }) => {
  await page.goto('./');
  await page.locator('.nd-app-bar:visible').getByRole('button', { name: 'About', exact: true }).click();
  const dialog = page.locator('#infoDialog');
  await expect(dialog).toContainText('decimated sample');
  await expect(dialog).toContainText('exes/nii2tvx');
  await page.locator('#infoDialog').getByRole('button', { name: 'Close' }).click();
  // Standalone is the shell's own dialog, rendered from registry/standalone.json. This app
  // ships no CLI release of its own, so it offers the shared desktop bundle.
  await page.locator('.nd-app-bar:visible').getByRole('button', { name: 'Standalone', exact: true }).click();
  await expect(page.locator('dialog[open]').last()).toContainText('Webapp standalone');
});

test('run is gated on a lesion, and the colorbar waits for a result', async ({ page }) => {
  await page.goto('./');
  await expect(page.locator('#statusText')).toContainText('Ready · choose', { timeout: 60_000 });
  await expect(page.locator('#runButton')).toBeDisabled();
  await expect(page.locator('#colorbar')).toBeHidden();
  await expect(page.locator('#saveButton')).toBeDisabled();
  // The MNI template stands in until an anatomical scan arrives.
  await expect(page.locator('#imageLabel')).toContainText('MNI152 TEMPLATE');
});

test('a lesion off the atlas grid is refused with advice, not answered', async ({ page }) => {
  await page.goto('./');
  await expect(page.locator('#statusText')).toContainText('Ready · choose', { timeout: 60_000 });
  // 20 mm cube: valid NIfTI, wrong grid.
  const wrong = readFileSync(fileURLToPath(new URL('../../../exes/nii2tvx/test/fixtures/lesion.nii.gz', import.meta.url)));
  await page.locator('#imageInput').setInputFiles({ name: 'wrong_grid.nii.gz', mimeType: 'application/gzip', buffer: wrong });
  await expect(page.locator('#runButton')).toBeEnabled({ timeout: 60_000 });
  await page.locator('#runButton').click();
  await expect(page.locator('#statusText')).toContainText('SYNcro', { timeout: 300_000 });
  await expect(page.locator('#statusText')).toHaveClass(/error/);
  await expect(page.locator('#saveButton')).toBeDisabled();
});

// The whole pipeline against the real atlases: tens of MB of downloads, so it is opt-in.
test('each atlas scores, draws and downloads its own CLI table', async ({ page }) => {
  test.skip(!process.env.DISCONNECTOME_LIVE_DATA, 'set DISCONNECTOME_LIVE_DATA=1 to fetch the real atlases');
  test.setTimeout(900_000);
  await page.goto('./');
  // ENIGMA is the default, so the first pass exercises it without touching the selector.
  await expect(page.locator('#atlasSelect')).toHaveValue('enigma');
  await page.locator('select[data-neurodesk-example]').selectOption('wm2208');
  await expect(page.locator('[data-neurodesk-examples]')).toHaveAttribute('data-example-state', 'ready', { timeout: 300_000 });
  await expect(page.locator('#runButton')).toBeEnabled({ timeout: 180_000 });
  await expect(page.locator('#imageLabel')).toContainText('LESION');

  const shown = async () => Number((await page.locator('#colorbarNote').textContent()).match(/^(\d+)/)[1]);

  const cases = [
    { atlas: 'enigma', bundles: 65, worst: 'ProjectionBasalGanglia_ThalamicRadiationL_Postcentral 100%' },
    { atlas: 'hcp1065', bundles: 87, worst: 'CBT_L 100%' },
  ];
  for (const { atlas, bundles, worst } of cases) {
    if (atlas !== 'enigma') {
      await page.locator('#atlasSelect').selectOption(atlas);
      // Switching atlas must discard the previous answer, not recolour it.
      await expect(page.locator('#colorbar')).toBeHidden();
      await expect(page.locator('#saveButton')).toBeDisabled();
      await expect(page.locator('#runButton')).toBeEnabled({ timeout: 60_000 });
      // The first pass left the slider raised; the Output section is open by now.
      await page.locator('#threshold').fill('0');
    }

    await page.locator('#runButton').click();
    await expect(page.locator('#statusText')).toContainText('bundles disconnected', { timeout: 600_000 });
    await expect(page.locator('#colorbar')).toBeVisible();
    await expect(page.locator('#colorbarNote')).toContainText(`of ${bundles} bundles shown`);
    await expect(page.locator('#damageSummary')).toContainText(worst);

    // Raising the threshold hides bundles without touching the numbers.
    const all = await shown();
    await page.locator('#threshold').fill('60');
    await expect(page.locator('#thresholdValue')).toHaveText('60');
    expect(await shown()).toBeLessThan(all);

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('#saveButton').click(),
    ]);
    expect(download.suggestedFilename()).toBe(`wM2208_T2w_lesion_${atlas}_disconnectome.tsv`);
    const [header, row] = readFileSync(await download.path(), 'utf8').trim().split('\n');
    const expected = readFileSync(golden[atlas], 'utf8').trim().split('\n');
    // Byte-identical to the command-line tool, whatever the slider is set to.
    expect(header).toBe(expected[0]);
    expect(row).toBe(expected.find((line) => line.startsWith('wM2208')));
    // The selector really changed the parcellation, not just the colours.
    expect(header.split('\t').length - 1).toBe(bundles);
  }
});
