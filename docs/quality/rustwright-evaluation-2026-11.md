# Rustwright evaluation, 1 November 2026

Decision for [#605](https://github.com/neurodesk/webapps/issues/605): keep Playwright. Rustwright's
Node binding cannot run any existing spec unchanged, and on the one spec that could be ported by hand
it was slower, not faster. Reopen only when the Node binding bridges the APIs listed below; that is
the state the issue asked to wait for. This extends the API-shape review in
[rustwright-feasibility-2026-10.md](rustwright-feasibility-2026-10.md) with a run of the real
package.

## What was tested

- Rustwright source at
  [`7d8f4c09`](https://github.com/Skyvern-AI/rustwright/tree/7d8f4c092cfa3f26d5307b5385233160e70e86a2)
  (15 October 2026, still the head on 1 November) and the npm package `rustwright@0.3.0`
  (tarball sha256 `1c863eec…49da6d`, no install scripts). Its `index.d.ts` equals the source's, so
  the published package and the repository have the same Node surface.
- Playwright 1.64.0, as resolved by `pnpm-lock.yaml`.
- Both drivers launched the same browser, Chrome for Testing 156.0.8078.4 from Playwright's
  `chromium-1248`, headless, on a 16-core Linux host.

## What the repository uses

Counted over `apps/*/e2e`, `packages/*/e2e`, `test/*.smoke.mjs`, `test-utils/` and `scripts/`.

| Playwright feature | Files | Rustwright Node 0.3.0 |
| --- | --- | --- |
| `@playwright/test` runner, `expect`, fixtures, `webServer` | 171 importers, 47 configs | None; it is a driver, not a test runner |
| Locators and role queries (`locator`, `getByRole` …) | 161 | No `locator` or `getBy*` |
| File inputs (`setInputFiles`, file chooser) | 130 | No `setInputFiles` |
| Downloads (`waitForEvent('download')`) | 107 | No `waitForEvent`; README lists downloads as not bridged |
| `waitForFunction`, `expect.poll`, `toPass` | 53, 91 | No `waitForFunction` |
| `addInitScript` | 46 | Not on page or context |
| Console and `pageerror` listeners | 26 | No `page.on` |
| Request routing (`page.route`, `context.route`) | 15 | Not on page or context |
| `serviceWorkers: 'block'` (COI worker hides requests from routing) | 4 configs | Context options keep only HTTPS-error and timeout |
| Device/viewport presets (`devices[…]`, `isMobile`) | 7 | No viewport option or `setViewportSize` |
| Tracing | 1 | No `context.tracing` |
| Sharding (`ci.e2e_shards`), `@slow` tags via `e2eTier` | 2 apps, 27 files | Runner features; nothing to map onto |
| WebGPU and SwiftShader flags (`test-utils/hardware-gpu.mjs`) | 24 | `launch({ args })` is accepted |
| macOS Metal runner (`browser-e2e-gpu`) | 1 job | darwin-arm64 binary ships; untested here |

The method list in the right column was checked at run time on a live Rustwright page and context,
not only from the type declarations. Only the last two rows are supported. The Node binding's
declarations (`node/index.d.ts`) state that `newContext()` has no storage or cookie isolation, and
`LIMITATIONS.md` says behavioural parity "is not fully proven".

## Side-by-side proof

No spec runs unchanged. The smallest one that avoids every missing API except polling and error
listeners is [`apps/musclemap/e2e/progress.spec.js`](../../apps/musclemap/e2e/progress.spec.js):
load a harness page, wait for `window.__ready`, read three values. It was ported by hand with
`waitForFunction` replaced by an `evaluate` loop every 50 ms. The port cannot assert "no page
errors", because Rustwright has no `pageerror` event; that check was dropped, so the port tests less
than the original.

Each trial launched a fresh browser against the same `web/run.sh` server on loopback. One warm-up
was discarded, then 10 trials per driver, run twice:

| Driver | Passed | Launch + new page (median) | Spec steps (median) | Total (median) |
| --- | --- | --- | --- | --- |
| Playwright 1.64.0 | 10/10, 10/10 | 660 ms, 722 ms | 556 ms, 571 ms | 1440 ms, 1650 ms |
| Rustwright 0.3.0 | 10/10, 10/10 | 1248 ms, 1240 ms | 559 ms, 549 ms | 2063 ms, 2120 ms |

The page work takes the same time under both drivers. Rustwright spent about 0.55 s longer starting
the browser. For reference, the full Playwright test, including the runner and its `webServer`,
took 8.5 s. The suites' run time is spent in WebAssembly and model inference inside the browser,
which a different CDP client does not change.

## Recommendation

Keep `@playwright/test`. Rustwright offers no measured speed gain here and lacks the runner and the
APIs that most suites use: uploads, downloads, locators, routing, init scripts and error listeners.
A migration would mean writing those or deleting the checks, and the second option is not
acceptable. Reconsider when a Rustwright release bridges at least `locator`, `setInputFiles`,
`waitForEvent('download')`, `route` and `page.on` in the Node binding. At that point, rerun the
comparison above on a spec that uploads a file and checks a download.
