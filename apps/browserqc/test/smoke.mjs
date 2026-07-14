// Headless-WebGPU browser smoke for BrowserQC.
//
// Boots `vite preview` on the production build, drives it in headless Chromium
// with WebGPU via SwiftShader (the recipe niivue's own e2e suite uses:
// --use-gl=angle --enable-unsafe-swiftshader), and asserts the full auto-run path
// that node smoke can't reach: WebGPU/NiiVue attach, Vite worker URLs, the default
// image load → conform → tfjs "Subcortical + GWM" segmentation (WebGL2) →
// native-space overlay → niimath --qc → QC panel populated, the Opacity slider, and
// that nothing throws to the page / logs to console.error.
//
// Usage:  npm run build && npm run test:e2e
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const PORT = 4173
const URL = `http://localhost:${PORT}/browserqc/`

// --- boot vite preview ---
// detached so the child is its own process-group leader; killing -pid then reaps
// the whole group (vite + its esbuild children). A plain preview.kill() would only
// signal the `npx` wrapper and orphan the actual server, leaking port 4173.
const preview = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
  cwd: root,
  stdio: 'inherit',
  detached: true,
})
let cleaned = false
const cleanup = () => {
  if (cleaned) return
  cleaned = true
  try { process.kill(-preview.pid, 'SIGTERM') } catch { /* already gone */ }
}
process.on('exit', cleanup)
process.on('SIGINT', () => { cleanup(); process.exit(130) })
process.on('SIGTERM', () => { cleanup(); process.exit(143) })

// --strictPort makes vite exit non-zero on a port clash; catch that so the test
// fails fast instead of polling a port served by some other (stale) process.
let previewExited = false
let previewExitCode = null
preview.on('exit', (code) => { previewExited = true; previewExitCode = code })

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
// poll the server until it answers
async function waitForServer(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (previewExited) {
      throw new Error(`vite preview exited (code ${previewExitCode}) before ready — port ${PORT} clash?`)
    }
    let ok = false
    try {
      ok = (await fetch(URL)).ok
    } catch { /* not up yet */ }
    if (ok) {
      // The port answered — but confirm it's OUR preview, not a STALE server that won the
      // port and forced our --strictPort child to exit (which would silently validate a
      // stale build). A strictPort bind failure exits the child within a few hundred ms,
      // so settle briefly and re-check before trusting the server.
      await wait(500)
      if (previewExited) {
        throw new Error(
          `port ${PORT} is served by another process — our --strictPort preview exited (code ${previewExitCode}); refusing to test a stale server`,
        )
      }
      return
    }
    await wait(300)
  }
  throw new Error('vite preview did not come up')
}

let browser
const fail = async (msg, page) => {
  console.error('\n❌ SMOKE FAIL:', msg)
  if (page) await page.screenshot({ path: join(here, 'smoke-fail.png') }).catch(() => {})
  if (browser) await browser.close().catch(() => {})
  cleanup()
  process.exit(1)
}

try {
  await waitForServer()
  // Use the system Google Chrome (channel) rather than Playwright's bundled
  // browser — it has full WebGPU and avoids a separate browser download. The
  // swiftshader/angle flags are a software-rendering fallback for headless.
  browser = await chromium.launch({
    headless: true,
    channel: 'chrome',
    args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--window-size=1280,960'],
  })
  const page = await browser.newPage()
  const consoleErrors = []
  const pageErrors = []
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
  page.on('pageerror', (e) => pageErrors.push(e.message))

  await page.goto(URL, { waitUntil: 'domcontentloaded' })

  // 1. QC panel starts empty — no metrics until the first segmentation runs.
  const qcText = () => page.$eval('#qcBody', (el) => el.textContent || '')
  if (!(await qcText()).includes('No QC values')) await fail('QC panel not empty on load', page)

  // 2. The app auto-runs on load: NiiVue attaches, the default image loads, then
  // conform → tfjs "Subcortical + GWM" segmentation (WebGL2) → native-space overlay →
  // niimath --qc. The terminal status is set only after the overlay is added, colored,
  // AND the parsed QC lands in the panel — so reaching it proves the whole path ran.
  // tfjs runs on the SwiftShader WebGL2 backend here (~15 s). Wiring-only: it asserts
  // the path runs clean and the panel populates, not the segmentation/QC *values*.
  await page.waitForFunction(
    () => /Segmentation \+ QC complete|QC unavailable/.test(document.getElementById('statusMsg')?.textContent || ''),
    undefined,
    { timeout: 240000 },
  ).catch(() => fail('auto segmentation + QC did not complete (NiiVue attach / model / niimath?)', page))
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

  // 5. Fatal on any uncaught page error OR console.error. The app is expected to
  // run clean (niimath chatter is buffered, the favicon 404 is suppressed); a
  // console error means a real regression. If a benign third-party error ever
  // appears, narrow it with an explicit allowlist here rather than downgrading.
  if (pageErrors.length) await fail('uncaught page errors:\n  ' + pageErrors.join('\n  '), page)
  if (consoleErrors.length) await fail('console.error output:\n  ' + consoleErrors.join('\n  '), page)
  console.log('✓ no console.error output')

  console.log('\n✅ SMOKE PASS')
  await browser.close()
  cleanup()
  process.exit(0)
} catch (e) {
  await fail(e?.stack || String(e))
}
