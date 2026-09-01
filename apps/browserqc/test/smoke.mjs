// Headless-WebGPU browser smoke for BrowserQC.
//
// Boots `vite preview` on the production build (via the shared test-utils
// helper) and drives it in Chrome. A system with a real WebGPU adapter
// exercises the full auto-run path that node smoke can't reach: NiiVue attach,
// image load → conform → tfjs segmentation → native-space overlay → niimath QC.
// GitHub's GPU-less Linux runner cannot execute NiiVue on SwiftShader (Dawn
// loses its external Instance during volume loading), so that environment
// instead asserts BrowserQC's explicit unsupported-WebGPU experience.
//
// Usage:  npm run build && npm run test:e2e
//         BROWSERQC_EXPECT_WEBGPU_FALLBACK=1 ...   (GPU-less box outside CI)
import { chromium } from 'playwright'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { runVitePreviewSmoke } from '../../../test-utils/vite-preview-smoke.mjs'

const here = dirname(fileURLToPath(import.meta.url))

await runVitePreviewSmoke({
  chromium,
  root: join(here, '..'),
  basePath: '/browserqc/',
  fallbackEnvVar: 'BROWSERQC_EXPECT_WEBGPU_FALLBACK',
  run: async ({ page, fail, expectWebGpuFallback, allowConsoleError }) => {
    // 1. QC panel starts empty — no metrics until the first segmentation runs.
    const qcText = () => page.$eval('#qcBody', (el) => el.textContent || '')
    if (!(await page.isVisible('#qcBody .qc-empty'))) await fail('QC panel not empty on load', page)

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
      await page.click('#aboutBtn')
      if (!(await page.isVisible('#aboutDialog'))) await fail('About dialog did not open', page)
      await page.click('#closeAboutBtn')
      console.log('✓ unsupported-WebGPU guidance shown, About dialog opens')
      return
    }

    // 2. The app auto-runs on load: NiiVue attaches, the default image loads, then
    // conform → tfjs "Subcortical + GWM" segmentation (WebGL2) → native-space overlay →
    // niimath --qc. The terminal status is set only after the overlay is added, colored,
    // AND the parsed QC lands in the panel — so reaching it proves the whole path ran.
    // tfjs runs on the SwiftShader WebGL2 backend here (~15 s). Wiring-only: it asserts
    // the path runs clean and the panel populates, not the segmentation/QC *values*.
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
    console.log('✓ auto segmentation + niimath QC ran, panel populated')

    // 3. Opacity slider drives the overlay (last volume) without throwing.
    await page.$eval('#ovlSlider', (el) => {
      el.value = '255'
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.value = '64'
      el.dispatchEvent(new Event('input', { bubbles: true }))
    })
    // 4. About dialog opens and closes.
    await page.click('#aboutBtn')
    if (!(await page.isVisible('#aboutDialog'))) await fail('About dialog did not open', page)
    await page.click('#closeAboutBtn')
    console.log('✓ Opacity slider driven, About dialog opens')
    // 5. The shared helper then fails on any uncaught page error or console.error.
  },
})
