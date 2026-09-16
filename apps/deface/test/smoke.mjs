// Headless-WebGPU browser smoke for the deface app (Part C validation).
//
// Boots `vite preview` on the production build (via the shared test-utils
// helper) and drives it in headless Chrome with WebGPU via SwiftShader (the
// recipe niivue's own e2e suite uses: --use-gl=angle --enable-unsafe-swiftshader),
// asserting the full path that node smoke can't reach: WebGPU/NiiVue attach,
// Vite worker URLs, the default image load, Apply (allineate fast, and
// allineate Hellinger with SMOKE_FULL=1), Save→download, and that nothing
// throws to the page / logs to console.error. GitHub's GPU-less Linux runner
// cannot initialize WebGPU at all, so that environment instead asserts deface's
// explicit unsupported-WebGPU experience (status message, fail-closed buttons).
//
// Usage:  npm run build && npm run test:e2e        (allineate fast only, ~fast)
//         SMOKE_FULL=1 npm run test:e2e            (also the slow Hellinger path)
//         DEFACE_EXPECT_WEBGPU_FALLBACK=1 ...      (GPU-less box outside CI)
import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { runVitePreviewSmoke } from '../../../test-utils/vite-preview-smoke.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const FULL = process.env.SMOKE_FULL === '1'

// Wait until the status label CONTAINS `m`. Passed as a real function (+ arg) so
// Playwright actually evaluates the predicate each poll — a STRING `() => …` would
// be evaluated to a truthy function object and pass immediately (a silent no-op).
const waitStatus = (page, m, timeout) =>
  page.waitForFunction(
    (needle) => (document.getElementById('statusMsg')?.textContent || '').includes(needle),
    m,
    { timeout },
  )

await runVitePreviewSmoke({
  chromium,
  port: Number(process.env.SMOKE_PORT || 4173),
  root: join(here, '..'),
  basePath: '/deface/',
  fallbackEnvVar: 'DEFACE_EXPECT_WEBGPU_FALLBACK',
  run: async ({ page, fail, expectWebGpuFallback, allowConsoleError }) => {
    await page.waitForSelector('.nd-app-bar')
    if (await page.locator('.nd-app-bar').count() !== 1) await fail('shared application bar is missing or duplicated', page)
    await page.click('[data-neurodesk-shell-control="about"]')
    if (!(await page.isVisible('#aboutDialog'))) await fail('About dialog did not open', page)
    await page.click('#aboutDialog .nd-dialog-close')
    await page.click('[data-neurodesk-shell-control="cite"]')
    if (!(await page.isVisible('dialog[open]'))) await fail('Cite dialog did not open', page)
    await page.click('dialog[open] button[aria-label="Close"]')
    await page.click('[data-neurodesk-shell-control="privacy"]')
    if (!(await page.isVisible('#privacyDialog'))) await fail('Privacy dialog did not open', page)
    await page.click('#privacyDialog .nd-dialog-close')

    const artifacts = join(process.env.TMPDIR || here, 'review-deface')
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

    // GitHub's Linux runners do not expose a usable WebGPU adapter. Verify that
    // init() reaches its intended fallback instead of hanging or crashing: the
    // status shows the unsupported-WebGPU message, and because init returns
    // before loading anything, Apply never enables (sourceFile/refFiles stay
    // unset — fail-closed) and Save stays disabled (the M2 privacy guard). Any
    // handled NiiVue adapter error is allowlisted; everything else stays fatal.
    if (expectWebGpuFallback) {
      await page.waitForFunction(
        () => /can.t initialize WebGPU/.test(document.getElementById('statusMsg')?.textContent || ''),
        undefined,
        { timeout: 30000 },
      ).catch(() => fail('unsupported-WebGPU message did not appear', page))
      if (!(await page.isDisabled('#applyBtn'))) await fail('Apply enabled without WebGPU (init must fail closed)', page)
      if (!(await page.isDisabled('#saveBtn'))) await fail('Save enabled without WebGPU (M2 privacy footgun)', page)
      allowConsoleError('Failed to get WebGPU adapter')
      console.log('✓ unsupported-WebGPU guidance shown and Apply/Save stay disabled')
      return
    }

    // 1. App initialized: Apply enables only after init() runs attachNiiVue() (NiiVue
    // attaches) AND the default image + MNI template load — so this single wait
    // subsumes the old explicit WebGPU-ready check (the #memstatus indicator was
    // removed; init failure leaves Apply disabled and this fails with a clear msg).
    await page.getByRole('combobox', { name: 'Example', exact: true }).selectOption('t1-head')
    await page.waitForSelector('#applyBtn:not([disabled])', { timeout: 30000 })
      .catch(() => fail('Apply never enabled (NiiVue attach / default image / refs not ready)', page))
    // M2 privacy guard: Save must be DISABLED before any deface, so the un-defaced
    // source can't be downloaded as defaced.nii.gz.
    if (!(await page.isDisabled('#saveBtn'))) await fail('Save enabled before any deface (M2 privacy footgun)', page)
    console.log('✓ App initialized (NiiVue attached, default image + refs loaded), Save correctly disabled pre-deface')

    // 3. Apply the default allineate (fast) deface — fast engine, no WebGPU needed. The
    // four allineate variants are two shared flags (crop / cost), not separate code paths,
    // so the default path exercises the wiring; robustfov/Hellinger differ only in argv.
    await page.selectOption('#methodSelect', 'allineate')
    await page.click('#applyBtn')
    await waitStatus(page, 'Defaced with allineate (fast)', 120000)
      .catch(() => fail('allineate (fast) did not complete', page))
    await page.screenshot({ path: join(here, 'smoke-allineate-fast.png') })
    console.log('✓ allineate (fast) ran and displayed')

    // 4. Save → must produce a browser download (Save is gated on a completed deface,
    // so by here it is enabled). Fatal: a broken Save must fail the smoke.
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 30000 }),
      page.click('#saveBtn'),
    ]).catch(() => fail('Save did not produce a download', page))
    console.log('✓ Save produced a download:', download.suggestedFilename())

    // 4b. mindgrab: needs WebGPU + shader-f16. Headless SwiftShader lacks f16, so the
    // expected outcome here is the graceful "needs WebGPU" dialog (NOT a crash). On a
    // real f16 GPU the run completes instead — accept either, fail only on neither.
    await page.selectOption('#methodSelect', 'mindgrab')
    await page.click('#applyBtn')
    const mindgrabOutcome = await page
      .waitForFunction(
        () =>
          document.getElementById('webgpuDialog')?.open === true ||
          (document.getElementById('statusMsg')?.textContent || '').includes('Brain-extracted with mindgrab'),
        undefined,
        { timeout: 120000 },
      )
      .then(() => true)
      .catch(() => false)
    if (!mindgrabOutcome) await fail('mindgrab neither completed nor showed the WebGPU dialog', page)
    const usedDialog = await page.evaluate(() => document.getElementById('webgpuDialog')?.open === true)
    if (!usedDialog) await page.screenshot({ path: join(here, 'smoke-mindgrab.png') })
    console.log(usedDialog ? '✓ mindgrab gated on missing WebGPU/f16 (dialog shown)' : '✓ mindgrab ran and displayed')
    if (usedDialog) {
      await page.click('#webgpuDialog .nd-dialog-close') // dismiss so it doesn't mask later checks
    }
    // The mindgrab border/robustfov variants differ only by argv flags (`-close 1 8 0` vs
    // `-bin`, and an upstream `-robustfov` crop) — that morphology/crop behavior is niimath's
    // to test. One mindgrab outcome (inference or the capability dialog) covers the app wiring.

    // 5. (optional) the slow exhaustive Hellinger path (`-cost hel`). Single-threaded WASM,
    // minutes on a full-head scan — hence gated behind SMOKE_FULL.
    if (FULL) {
      await page.selectOption('#methodSelect', 'allineate_hel')
      await page.click('#applyBtn')
      await waitStatus(page, 'Defaced with allineate (Hellinger)', 300000)
        .catch(() => fail('allineate (Hellinger) did not complete', page))
      await page.screenshot({ path: join(here, 'smoke-allineate-hel.png') })
      console.log('✓ allineate (Hellinger) ran and displayed')
    } else {
      console.log('• skipped slow Hellinger path (set SMOKE_FULL=1 to include)')
    }
    // 6. The shared helper then fails on any uncaught page error or console.error.
  },
})
