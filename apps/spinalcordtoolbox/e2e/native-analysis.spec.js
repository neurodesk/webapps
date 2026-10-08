import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { startReferenceServer } from '../../../test-utils/compute-reference-server.mjs';
import { syntheticNifti } from '../../../test-utils/nifti-fixture.mjs';

let server;
const mask = syntheticNifti({ value: () => 1 });
test.beforeAll(async () => { server = await startReferenceServer({ stageDelayMs: 100 }); });
test.afterAll(async () => { await server.close(); });

async function mount(page) {
    await page.goto('/harness.html');
    await page.evaluate(async () => {
        const { SctAnalysis } = await import('./js/controllers/SctAnalysis.js');
        const { ProgressManager } = await import('@neurodesk/webapp-components/ui');
        document.body.innerHTML = '<aside id="controls"><div id="before"></div></aside><footer id="status"><span id="statusText"></span><span id="elapsed"></span><progress id="progress"></progress><button id="cancelButton">×</button></footer>';
        window.analysis = new SctAnalysis({ before: document.getElementById('before'), progress: new ProgressManager(), log: () => {} });
        document.getElementById('cancelButton').onclick = () => window.analysis.cancel();
        window.analysis.section.open = true;
    });
    await page.locator('#sctAnalysisExecution').selectOption('server');
    await page.locator('#sctComputeConnection').evaluate(async (connection, origin) => {
        connection.address = origin;
        connection.token = 'test-token';
        await connection.connect();
    }, server.origin);
    await expect(page.locator('#sctComputeConnection')).toHaveAttribute('data-state', 'simulated');
}

test('mask-only morphometry downloads original bytes and can reopen a server job', async ({ page }) => {
    await mount(page);
    await page.locator('#sctCordMask').setInputFiles({ name: 'cord.nii.gz', mimeType: 'application/gzip', buffer: mask });
    await expect(page.locator('#statusText')).toHaveText('');
    await page.locator('#sctMorphometryOptions > summary').click();
    await page.locator('#sctPerSlice').check();
    await page.locator('#sctSlices').fill('1:3');
    await page.locator('#sctRunAnalysis').click();
    await expect(page.locator('#statusText')).toHaveText('Simulated SCT results ready');
    await expect(page.locator('#sctAnalysisResults')).toHaveAttribute('open', '');
    const downloading = page.waitForEvent('download');
    await page.locator('#sctAnalysisResults [data-stage="morphometry.csv"] .nd-download-btn').click();
    const download = await downloading;
    expect(download.suggestedFilename()).toBe('morphometry.csv');
    expect(await readFile(await download.path(), 'utf8')).toBe('Simulated,MEAN(area)\ntrue,0\n');
    await page.locator('#sctPreviousJobs > summary').click();
    await expect(page.locator('#sctPreviousJob option')).toHaveCount(1);
    await page.locator('#sctResumeJob').click();
    await expect(page.locator('#statusText')).toHaveText('Simulated SCT results ready');
});

test('generated lesion mask stays local until Run and cancellation stays in the footer', async ({ page }) => {
    await mount(page);
    await page.locator('#sctAnalysisCommand').selectOption('analyze_lesion');
    await page.evaluate(bytes => window.analysis.setGenerated({ lesion: new File([new Uint8Array(bytes)], 'current-lesion.nii.gz') }), Array.from(mask));
    await page.locator('#sctLesionSource').selectOption('generated');
    await expect(page.locator('#sctCordSource')).toHaveValue('none');
    await expect(page.locator('#sctPreviousJob option')).toHaveCount(0);
    await page.locator('#sctRunAnalysis').click();
    await expect(page.locator('#cancelButton')).toBeVisible();
    await page.locator('#cancelButton').click();
    await expect(page.locator('#statusText')).toHaveText('Analysis cancelled');
    await expect(page.locator('#cancelButton')).toBeHidden();
    await page.locator('#sctRunAnalysis').click();
    await expect(page.locator('#statusText')).toHaveText('Simulated SCT results ready');
    await expect(page.locator('#sctAnalysisResults [data-stage="lesion_analysis.xlsx"]')).toBeVisible();
    const downloading = page.waitForEvent('download');
    await page.locator('#sctAnalysisResults [data-stage="lesion_label.nii.gz"] .nd-download-btn').click();
    expect(await readFile(await (await downloading).path())).toEqual(mask);
});

test('browser SCT analyzes masks without a server and downloads both upstream formats', async ({ page }) => {
    test.setTimeout(180000);
    const { analysisFixture } = await import('../scripts/analysis-fixtures.mjs');
    await page.goto('/harness.html');
    await page.evaluate(async () => {
        const { SctAnalysis } = await import('./js/controllers/SctAnalysis.js');
        const { ProgressManager } = await import('@neurodesk/webapp-components/ui');
        document.body.innerHTML = '<aside id="controls"><div id="before"></div></aside><footer id="status"><span id="statusText"></span><span id="elapsed"></span><progress id="progress"></progress><button id="cancelButton">×</button></footer>';
        window.analysis = new SctAnalysis({ before: document.getElementById('before'), progress: new ProgressManager(), log: () => {} });
        document.getElementById('cancelButton').onclick = () => window.analysis.cancel();
        window.analysis.section.open = true;
    });
    const apiRequests = [];
    page.on('request', request => { if (request.url().includes('/api/v1/')) apiRequests.push(request.url()); });
    await expect(page.locator('#sctAnalysisExecution')).toHaveValue('browser');
    await expect(page.locator('#sctComputeConnection')).toBeHidden();
    await page.locator('#sctCordMask').setInputFiles({ name: 'cord.nii.gz', mimeType: 'application/gzip', buffer: analysisFixture('cord') });
    await page.locator('#sctRunAnalysis').click();
    await expect(page.locator('#cancelButton')).toBeVisible();
    await page.locator('#cancelButton').click();
    await expect(page.locator('#statusText')).toHaveText('Analysis cancelled');
    await page.locator('#sctRunAnalysis').click();
    await expect(page.locator('#statusText')).toHaveText('Browser SCT results ready', { timeout: 90000 });
    const csvDownloading = page.waitForEvent('download');
    await page.locator('#sctAnalysisResults [data-stage="morphometry.csv"] .nd-download-btn').click();
    const csv = await readFile(await (await csvDownloading).path(), 'utf8');
    expect(csv).toContain('MEAN(area)');
    expect(csv).toContain('/job/in/cord.nii.gz');
    expect(csv).not.toContain('Simulated');
    await page.locator('#sctAnalysisCommand').selectOption('analyze_lesion');
    await page.locator('#sctLesionMask').setInputFiles({ name: 'lesion.nii.gz', mimeType: 'application/gzip', buffer: analysisFixture('lesion') });
    await page.locator('#sctRunAnalysis').click();
    await expect(page.locator('#statusText')).toHaveText('Browser SCT results ready', { timeout: 90000 });
    const workbookDownloading = page.waitForEvent('download');
    await page.locator('#sctAnalysisResults [data-stage="lesion_analysis.xlsx"] .nd-download-btn').click();
    const workbook = await workbookDownloading;
    expect(workbook.suggestedFilename()).toBe('lesion_analysis.xlsx');
    expect((await readFile(await workbook.path())).subarray(0, 2).toString()).toBe('PK');
    await expect(page.locator('#sctAnalysisResults [data-stage="lesion_label.nii.gz"]')).toBeVisible();
    expect(apiRequests).toEqual([]);
});
