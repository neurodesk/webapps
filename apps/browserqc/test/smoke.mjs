// Headless-WebGPU browser smoke for BrowserQC.
//
// Boots `vite preview` on the production build (via the shared test-utils
// helper) and drives it in Chrome. A system with a real WebGPU adapter
// exercises the full auto-run path that node smoke can't reach: NiiVue attach,
// image load → MindGrab segmentation → native-space overlay → niimath QC.
// GitHub's GPU-less Linux runner cannot execute NiiVue on SwiftShader (Dawn
// loses its external Instance during volume loading), so that environment
// instead asserts BrowserQC's explicit unsupported-WebGPU experience.
//
// Usage:  npm run build && npm run test:e2e
//         BROWSERQC_EXPECT_WEBGPU_FALLBACK=1 ...   (GPU-less box outside CI)
import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { runVitePreviewSmoke } from '../../../test-utils/vite-preview-smoke.mjs'

const here = dirname(fileURLToPath(import.meta.url))

await runVitePreviewSmoke({
  chromium,
  port: Number(process.env.SMOKE_PORT || 4173),
  root: join(here, '..'),
  basePath: '/browserqc/',
  fallbackEnvVar: 'BROWSERQC_EXPECT_WEBGPU_FALLBACK',
  run: async ({ page, fail, expectWebGpuFallback, allowConsoleError }) => {
    // 1. QC panel starts empty — no metrics until the first segmentation runs.
    const qcText = () => page.$eval('#qcBody', (el) => el.textContent || '')
    if (await page.locator('#resultsSection').evaluate(el => el.open)) await fail('Empty results should start collapsed', page)
    if (!/Metrics appear/.test(await qcText())) await fail('QC panel not empty on load', page)

    await page.setViewportSize({ width: 320, height: 568 })
    const locationFits = await page.locator('#location').evaluate(
      el => el.getBoundingClientRect().right <= document.documentElement.clientWidth + 1,
    )
    if (!locationFits) await fail('Status text overflows a 320px viewport', page)
    await page.click('[data-neurodesk-shell-control="about"]')
    if (!(await page.isVisible('#aboutDialog'))) await fail('About dialog did not open', page)
    await page.click('#aboutDialog .nd-dialog-close')
    await page.click('[data-neurodesk-shell-control="cite"]')
    await page.click('dialog[open] button[aria-label="Close"]')
    await page.click('[data-neurodesk-shell-control="privacy"]')
    await page.click('#privacyDialog .nd-dialog-close')
    await page.setViewportSize({ width: 1280, height: 960 })

    const artifacts = join(process.env.TMPDIR || here, 'review-browserqc')
    await mkdir(artifacts, { recursive: true })
    const consoleToggle = page.locator('#technicalLog [data-disclosure-toggle]')
    await consoleToggle.click()
    if (await consoleToggle.getAttribute('aria-expanded') !== 'true') await fail('Technical log did not expand', page)
    await page.click('#clearLogBtn')
    await consoleToggle.click()
    for (const [name, width, height] of [['desktop', 1280, 960], ['phone', 320, 568]]) {
      await page.setViewportSize({ width, height })
      await page.screenshot({ path: join(artifacts, `${name}.png`), fullPage: true })
      await page.click('[data-neurodesk-theme-toggle]')
      await page.screenshot({ path: join(artifacts, `${name}-light.png`), fullPage: true })
      await page.click('[data-neurodesk-theme-toggle]')
    }
    await page.setViewportSize({ width: 1280, height: 960 })

    // GitHub's Linux runners do not expose a usable WebGPU adapter. Verify that the
    // production app reaches its intended, actionable fallback instead of hanging or
    // crashing. The one NiiVue console error is the underlying adapter failure that
    // the UI has handled; any other page/console error remains fatal.
    if (expectWebGpuFallback) {
      await page.waitForFunction(
        () => /can.t initialize WebGPU/.test(document.getElementById('statusMsg')?.textContent || ''),
        undefined,
        { timeout: 30000 },
      ).catch(() => fail('unsupported-WebGPU message did not appear', page))
      allowConsoleError('Failed to get WebGPU adapter')
      allowConsoleError('Unable to initialize WebGL2')
      console.log('✓ unsupported-WebGPU guidance shown; shared dialogs and mobile status fit work')
      return
    }

    await page.getByRole('combobox', { name: 'Example', exact: true }).selectOption('t1-head')
    await page.waitForSelector('#runButton:not([disabled])', { timeout: 120000 })
    await page.click('#runButton')
    await page.waitForFunction(
      () => /Segmentation \+ QC complete|QC unavailable|can.t initialize WebGPU|^Failed:/.test(
        document.getElementById('statusMsg')?.textContent || '',
      ),
      undefined,
      // GitHub's software-rendered WebGL runner is substantially slower than a
      // developer workstation. Keep this a real segmentation/QC assertion, but
      // allow enough time for the 256³ model to finish without a false timeout.
      { timeout: 600000 },
    ).catch(() => fail('auto segmentation + QC did not complete (NiiVue attach / model / niimath?)', page))
    const terminalStatus = await page.$eval('#statusMsg', (el) => el.textContent || '')
    if (/can.t initialize WebGPU/.test(terminalStatus)) {
      await fail('WebGPU adapter initialization failed', page)
    }
    if (/^Failed:/.test(terminalStatus)) await fail(terminalStatus, page)
    if (!/CJV/.test(await qcText())) await fail('QC panel did not populate after segmentation', page)
    if (await page.locator('#saveBtn').isDisabled()) await fail('QC JSON save did not enable', page)
    console.log('✓ auto segmentation + niimath QC ran, panel populated')

    // 3. Opacity slider drives the overlay (last volume) without throwing.
    await page.$eval('#ovlSlider', (el) => {
      el.value = '255'
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.value = '64'
      el.dispatchEvent(new Event('input', { bubbles: true }))
    })
    // 4. Save the completed QC report.
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.click('#saveBtn'),
    ])
    if (!/_qc\.json$/.test(download.suggestedFilename())) await fail('QC report did not download as JSON', page)
    console.log('✓ Shared dialogs and QC JSON download work')
    // 5. The shared helper then fails on any uncaught page error or console.error.
  },
})
