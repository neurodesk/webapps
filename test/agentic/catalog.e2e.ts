import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { test as base } from '@e2e-dev/web';
import { expect } from 'e2e';
import { z } from 'zod';
import { agenticCatalog } from '../../test-utils/agentic-catalog.mjs';
import { pipelineSettled } from '../../test-utils/agentic-pipeline-state.mjs';
import { loadAppContract } from '../../scripts/lib/app-automation.mjs';
import { repoRoot } from '../../scripts/lib/apps-registry.mjs';

const catalog = await agenticCatalog();
const test = base.extend<{ downloads: { resolve(path: string): string } }>();
const infoDialog = 'dialog[open], .modal-overlay.active .modal:visible, .nd-modal-overlay.active .nd-modal:visible, [role="dialog"]:not([hidden]):visible';

test.beforeEach(async ({ browser }) => {
  await browser.route(/googletagmanager\.com|google-analytics\.com/, route => route.abort());
});

for (const entry of catalog) {
  test.describe(entry.id, { tags: [entry.id] }, () => {
    test('production workspace and example inventory', { tags: ['workspace'] }, async ({ app, browser }) => {
      await app.open(`/${entry.path}/`);
      await expect(browser.locator('.nd-app-bar:visible')).toHaveCount(1);
      await expect(browser.locator('footer#status')).toBeVisible();
      const { version } = JSON.parse(await readFile(join(repoRoot, 'apps', entry.id, 'package.json'), 'utf8'));
      const expected = await loadAppContract(entry, version);
      await expect.poll(() => browser.evaluate('() => Boolean(globalThis.neurodeskAutomation)')).toBe(true);
      const actual = await browser.evaluate("() => globalThis.neurodeskAutomation.dispatch('describe')");
      expect(actual).toEqual(expected);
      const selector = browser.locator('select[data-neurodesk-example]');
      if (entry.examples.length === 0) {
        await expect(selector).toHaveCount(0);
        await expect(browser.locator('input[type="file"]').first()).toBeEnabled();
      } else {
        await expect(selector).toHaveCount(1);
        const options = await browser.evaluate(() => Array.from(
          document.querySelectorAll<HTMLOptionElement>('select[data-neurodesk-example] option'),
          option => ({ id: option.value, label: option.textContent }),
        ).filter(option => option.id));
        expect(options).toEqual(entry.examples.map(example => ({ id: example.id, label: example.label })));
      }
    });

    test('agent opens and closes About and Cite', { tags: ['agent', 'help'] }, async ({ app, agent, browser }) => {
      await app.open(`/${entry.path}/`);
      for (const action of ['About', 'Cite']) {
        await agent.act(`Open the ${action} dialog using the application bar. Leave the dialog open.`);
        await expect(browser.locator(infoDialog)).toHaveCount(1);
        await expect(browser.locator(infoDialog)).toContainText(action === 'About' ? entry.title : /cit|reference/i);
        await agent.act('Close the open dialog by clicking its close button, labelled Close or ×. Return as soon as the dialog closes.');
        await expect(browser.locator(infoDialog)).toHaveCount(0);
        await expect(browser.locator('.nd-app-bar:visible')).toHaveCount(1);
      }
    });

    for (const example of entry.examples) {
      test(`agent imports ${example.id}`, { tags: ['agent', 'example'] }, async ({ app, agent, browser }) => {
        await app.open(`/${entry.path}/`);
        await agent.act('Choose the example labelled {label} from the Example selector. Leave processing controls untouched.', {
          params: { label: example.label },
        });
        const state = browser.locator('[data-neurodesk-examples]');
        await expect(state).toHaveAttribute('data-example-state', 'ready', { timeout: 300000 });
        await expect(state).toHaveAttribute('data-example-id', example.id);
        await expect(browser.locator('select[data-neurodesk-example]')).toBeEnabled();
      });
    }

    const example = entry.examples[0];
    if (!example) {
      test('agent processes the example and downloads a result', {
        tags: ['agent', 'pipeline'],
      }, async () => {
        test.skip('No scientifically suitable public example is available for this app.');
      });
    } else if (entry.id === 'dicompare') {
      test('agent inspects the example comparison and opens report options', {
        tags: ['agent', 'pipeline'],
      }, async ({ app, agent, browser, screen }) => {
        await app.open(`/${entry.path}/`);
        await browser.locator('select[data-neurodesk-example]').selectOption({ value: example.id });
        await expect(browser.locator('[data-neurodesk-examples]')).toHaveAttribute('data-example-state', 'ready', { timeout: 300000 });
        await agent.act('Inspect the loaded reference and matching test acquisition, then open its Print options. Leave the print options open.');
        await expect(browser.locator('.uppercase').filter({ hasText: /^(Reference|Test data)$/ })).toHaveCount(2);
        await expect(screen.getByRole('heading', 'Print Options')).toBeVisible();
        await expect(screen.getByRole('checkbox', 'Fields Table')).toBeChecked();
      });
    } else if (entry.id === 'nesvor') {
      test('agent submits the example to a simulated compute server and downloads its response', {
        tags: ['agent', 'pipeline'],
      }, async ({ app, agent, browser, downloads }) => {
        const { startReferenceServer } = await import('../../test-utils/compute-reference-server.mjs');
        const server = await startReferenceServer();
        try {
          await app.open(`/${entry.path}/`);
          await browser.locator('select[data-neurodesk-example]').selectOption({ value: example.id });
          await expect(browser.locator('[data-neurodesk-examples]')).toHaveAttribute('data-example-state', 'ready', { timeout: 300000 });
          await browser.locator('#executionMode').selectOption({ value: 'remote' });
          const panel = browser.locator('#computeConnection');
          await browser.locator('#computeConnection input[type="text"]').fill(server.origin);
          await browser.locator('#computeConnection input[type="password"]').fill(server.token);
          await agent.act('Connect to the configured local reference compute server.');
          await expect(panel).toHaveAttribute('data-state', 'simulated');
          await agent.act('Run reconstruction on the loaded synthetic stacks using the connected compute server. Return once the task starts.');
          await expect(browser.locator('#resultList button').filter({ hasText: 'Download' }).first()).toBeEnabled({ timeout: 120000 });
          const download = await browser.waitForDownload(async () => {
            await agent.act('Download the reconstructed NIfTI volume from the results.');
          });
          expect(download.suggestedFilename).toMatch(/\.nii(\.gz)?$/);
          expect((await stat(downloads.resolve(download.path))).size).toBeGreaterThan(0);
          await expect(browser.locator('footer#status')).not.toContainText(/\b(error|failed|unable)\b/i);
        } finally {
          await server.close();
        }
      });
    } else if (entry.id === 'zarro') {
      test('agent explores microscopy and downloads the field of view', {
        tags: ['agent', 'pipeline'],
      }, async ({ app, agent, browser, downloads }) => {
        await app.open(`/${entry.path}/`);
        await browser.locator('select[data-neurodesk-example]').selectOption({ value: example.id });
        await expect(browser.locator('[data-neurodesk-examples]')).toHaveAttribute('data-example-state', 'ready', { timeout: 300000 });
        await browser.locator('#toolsPanel > summary').click();
        await expect(browser.locator('#downloadNifti')).toBeEnabled();
        await agent.act('Explore the loaded cell microscopy by changing the zoom level or axial slice. Keep Measure & export open and leave the download action unclicked.');
        const download = await browser.waitForDownload(async () => {
          await agent.act('Download the current field of view as NIfTI using the download FOV button in Measure & export.');
        }, { timeout: 120000 });
        expect(download.suggestedFilename).toMatch(/\.nii$/);
        const { readVolume } = await import('../../packages/synthsr/src/volume.js');
        const bytes = await readFile(downloads.resolve(download.path));
        const volume = readVolume(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
        expect(volume.dims[2]).toBe(3);
        expect(volume.data.some(value => value > 0)).toBe(true);
        expect(volume.data.some(value => value !== volume.data[0])).toBe(true);
      });
    } else if (entry.id === 'surfannotate') {
      test('agent closes a drawn cortical ROI and exports a label', {
        tags: ['agent', 'pipeline'],
      }, async ({ app, agent, browser, screen, downloads }) => {
        await app.open(`/${entry.path}/`);
        await browser.locator('select[data-neurodesk-example]').selectOption({ value: example.id });
        await expect(browser.locator('[data-neurodesk-examples]')).toHaveAttribute('data-example-state', 'ready', { timeout: 300000 });
        await agent.act('Choose the Closed ROI drawing tool. Leave the loaded surface visible.');
        // The text-only model cannot visually place a cortical border. Supply
        // real pointer clicks; the agent closes, saves and exports the region.
        const rectangle = await browser.evaluate(() => {
          const canvas = document.querySelector('canvas');
          if (!canvas) throw new Error('The cortical viewer has no canvas.');
          const { x, y, width, height } = canvas.getBoundingClientRect();
          return { x, y, width, height };
        });
        for (const [x, y] of [[0.46, 0.46], [0.54, 0.46], [0.54, 0.54], [0.46, 0.54]]) {
          await screen.tapAt({ x: rectangle.x + rectangle.width * x, y: rectangle.y + rectangle.height * y });
        }
        await expect(browser.locator('#closePath')).toBeEnabled();
        await agent.act('Close the drawn ROI, fill it, and save the filled region with the name agentic-cortex. Leave export unclicked.');
        await expect(browser.locator('#roiList')).toContainText('agentic-cortex');
        const download = await browser.waitForDownload(async () => {
          await agent.act('Export the saved cortical region as a FreeSurfer .label file.');
        });
        expect(download.suggestedFilename).toMatch(/\.label$/);
        const lines = (await readFile(downloads.resolve(download.path), 'utf8')).trim().split('\n');
        expect(lines[0]).toMatch(/^#!ascii label/);
        const count = Number(lines[1]);
        expect(count).toBeGreaterThan(0);
        expect(lines.length).toBe(count + 2);
      });
    } else {
      test('agent processes the example and downloads a result', {
        tags: ['agent', 'pipeline'],
        timeout: 7200000,
      }, async ({ app, agent, browser, downloads }) => {
        await app.open(`/${entry.path}/`);
        await browser.locator('select[data-neurodesk-example]').selectOption({ value: example.id });
        await expect(browser.locator('[data-neurodesk-examples]')).toHaveAttribute('data-example-state', 'ready', { timeout: 300000 });
        if (entry.id === 'vesselboost') {
          for (const [section, skip] of [
            ['stepDownsampleSection', 'skipDownsampleBtn'],
            ['stepN4Section', 'skipN4Btn'],
            ['stepDenoiseSection', 'skipDenoiseBtn'],
          ]) {
            if (await browser.evaluate(`() => document.getElementById('${section}').classList.contains('collapsed')`)) {
              await browser.locator(`#${section} [data-disclosure-toggle]`).click();
            }
            await browser.locator(`#${skip}`).click();
          }
          await expect(browser.locator('#runSegmentation')).toBeEnabled();
        }
        if (entry.id === 'niimath') {
          await agent.act('Set the NiiMath command to exactly {command}. Leave Process unclicked.', {
            params: { command: '-mul 0 -add 7' },
          });
          await expect(browser.locator('#command')).toHaveValue('-mul 0 -add 7');
        }
        if (entry.id === 'syncro' && process.platform === 'linux' && process.env.E2E_SOFTWARE_GPU !== '0') {
          await agent.act('Open Processing settings and set SynthSR device to CPU · WebAssembly. Leave Normalize to MNI unclicked.');
          await expect(browser.locator('#synthsrBackend')).toHaveValue('wasm');
        }
        let completed = false;
        for (let stage = 0; stage < 8 && !completed; stage += 1) {
          await agent.act('Advance the main workflow on the loaded example toward {outcome}. Use the visible controls. If the app requests mask review, confirm the generated example mask to continue mapping. Skip optional preprocessing if it gates the main Run action. Scroll the sidebar to reach controls below the fold. Return immediately once a processing task has started, or if the expected results are already available. Do not restart an analysis already in progress, wait for a long-running task, or click download.', {
            params: { outcome: example.expectedResult },
            timeout: 300000,
          });
          await expect.poll(async () => pipelineSettled(entry.id, await browser.evaluate(() => {
            const footer = document.querySelector('footer#status');
            const progress = footer?.querySelector('progress');
            return {
              text: footer?.querySelector('[role="status"], #statusText')?.textContent ?? footer?.textContent ?? '',
              value: !progress ? 1 : progress.hasAttribute('value') ? progress.value : null,
              max: progress?.max ?? 1,
            };
          })), { timeout: 1800000 }).toBe(true);
          await expect(browser.locator('footer#status')).not.toContainText(/\b(error|failed|unable)\b/i);
          const result = await agent.extract(`Extract an object with a completed boolean describing the output-control state for this workflow: ${example.expectedResult}. Set completed to true only when processed scientific outputs are available to download. If results are absent, another processing step is needed, or only the input image or screenshot can be saved, return the object { "completed": false }. The absence of results is an answer, not missing data.`, {
            schema: z.object({ completed: z.boolean() }),
          });
          completed = result.completed;
          if (entry.id === 'calmar') {
            completed = completed && await browser.locator('#downloadNetworkMapButton').isEnabled();
          }
        }
        expect(completed).toBe(true);
        const download = await browser.waitForDownload(async () => {
          await agent.act(entry.id === 'calmar'
            ? 'Download the completed lesion-network map as NIfTI using Download network map.'
            : 'Download one scientific result from the completed workflow using its download or save control.');
        }, { timeout: 120000 });
        const downloadPath = downloads.resolve(download.path);
        expect((await stat(downloadPath)).size).toBeGreaterThan(0);
        expect(download.suggestedFilename).toMatch(/\.(nii(\.gz)?|zip|tsv|csv|json|stl|obj|mz3|gii|png|mp4|webm|pdf|html|txt|tck|trx|label|mat|coord|table|sdat)$/i);
        if (entry.id === 'dwi2trx') expect(download.suggestedFilename).toMatch(/\.trx$/);
        if (entry.id === 'calmar') {
          expect(download.suggestedFilename).toBe('lnm-network-map.nii');
          const { readVolume } = await import('../../packages/synthsr/src/volume.js');
          const bytes = await readFile(downloadPath);
          const result = readVolume(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
          expect(result.data.every(Number.isFinite)).toBe(true);
          expect(result.data.some(value => value !== 0)).toBe(true);
          expect(result.data.some(value => value !== result.data[0])).toBe(true);
        }
        await expect(browser.locator('[data-neurodesk-state="failed"]')).toHaveCount(0);
        if (entry.id === 'niimath') {
          const { readVolume } = await import('../../packages/synthsr/src/volume.js');
          const bytes = await readFile(downloadPath);
          const result = readVolume(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
          expect(result.dims).toEqual([166, 210, 160]);
          expect(result.data.length).toBeGreaterThan(0);
          expect(result.data.every(value => value === 7)).toBe(true);
        }
      });
    }
  });
}
