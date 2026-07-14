// Headless-WebGPU browser smoke for BrowserQC.
//
// Boots `vite preview` on the production build and drives it in Chrome. A system
// with a real WebGPU adapter exercises the full auto-run path that node smoke can't
// reach: NiiVue attach, image load → conform → tfjs segmentation → native-space
// overlay → niimath QC. GitHub's GPU-less Linux runner cannot execute NiiVue on
// SwiftShader (Dawn loses its external Instance during volume loading), so that
// environment instead asserts BrowserQC's explicit unsupported-WebGPU experience.
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
const EXPECT_WEBGPU_FALLBACK = process.env.BROWSERQC_EXPECT_WEBGPU_FALLBACK === '1'
  || (process.platform === 'linux' && process.env.CI === 'true')
const webGpuArgs = [
  '--use-gl=angle',
  '--enable-unsafe-swiftshader',
  ...(EXPECT_WEBGPU_FALLBACK ? ['--disable-gpu', '--disable-software-rasterizer'] : []),
]

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
const consoleErrors = []
const pageErrors = []
const fail = async (msg, page) => {
  console.error('\n❌ SMOKE FAIL:', msg)
  if (page) {
    const status = await page.$eval('#statusMsg', (el) => el.textContent || '').catch(() => '')
    if (status) console.error('Last BrowserQC status:', status)
    if (pageErrors.length) console.error('Page errors:\n  ' + pageErrors.join('\n  '))
    if (consoleErrors.length) console.error('Console errors:\n  ' + consoleErrors.join('\n  '))
  }
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
    args: [...webGpuArgs, '--window-size=1280,960'],
  })
  const page = await browser.newPage()
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
  page.on('pageerror', (e) => pageErrors.push(e.message))

  await page.goto(URL, { waitUntil: 'domcontentloaded' })

  // 1. QC panel starts empty — no metrics until the first segmentation runs.
  const qcText = () => page.$eval('#qcBody', (el) => el.textContent || '')
  if (!(await qcText()).includes('No QC values')) await fail('QC panel not empty on load', page)

  // GitHub's Linux runners do not expose a usable WebGPU adapter. Verify that the
  // production app reaches its intended, actionable fallback instead of hanging or
  // crashing. The one NiiVue console error is the underlying adapter failure that
  // the UI has handled; any other page/console error remains fatal.
  if (EXPECT_WEBGPU_FALLBACK) {
    await page.waitForFunction(
      () => /can.t initialize WebGPU/.test(document.getElementById('statusMsg')?.textContent || ''),
      undefined,
      { timeout: 30000 },
    ).catch(() => fail('unsupported-WebGPU message did not appear', page))
    if (pageErrors.length) await fail('uncaught page errors:\n  ' + pageErrors.join('\n  '), page)
    const unexpectedErrors = consoleErrors.filter((message) => !message.includes('Failed to get WebGPU adapter'))
    if (unexpectedErrors.length) await fail('unexpected console.error output:\n  ' + unexpectedErrors.join('\n  '), page)
    await page.click('#aboutBtn')
    if (!(await page.isVisible('#aboutDialog'))) await fail('About dialog did not open', page)
    await page.click('#closeAboutBtn')
    console.log('✓ unsupported-WebGPU guidance shown, About dialog opens')
    await browser.close()
    cleanup()
    process.exit(0)
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
