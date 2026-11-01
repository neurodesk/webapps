# Rustwright feasibility for webapps, 25 October 2026

Superseded by [rustwright-evaluation-2026-11.md](rustwright-evaluation-2026-11.md), which runs the package.

Investigation for [#605](https://github.com/neurodesk/webapps/issues/605). Retain the existing
Playwright scientific/UI suites. The inspected Rustwright Node binding lacks APIs these suites
require, and its context shim does not promise their storage/cookie isolation. A separate bounded
workflow could be evaluated without replacing those tests.

## Source and verification scope

Inspected [Skyvern-AI/rustwright commit
7d8f4c092cfa3f26d5307b5385233160e70e86a2](https://github.com/Skyvern-AI/rustwright/tree/7d8f4c092cfa3f26d5307b5385233160e70e86a2),
specifically
[node/index.cjs](https://github.com/Skyvern-AI/rustwright/blob/7d8f4c092cfa3f26d5307b5385233160e70e86a2/node/index.cjs),
[node/index.mjs](https://github.com/Skyvern-AI/rustwright/blob/7d8f4c092cfa3f26d5307b5385233160e70e86a2/node/index.mjs)
and [Node
README](https://github.com/Skyvern-AI/rustwright/blob/7d8f4c092cfa3f26d5307b5385233160e70e86a2/node/README.md).
CommonJS wrapper SHA-256: 1419eeff5cfdb7346e536de2b6058e2c99cce51beea4b77ebcc7629a06b2578a.

A local probe executed the unmodified public JavaScript wrapper with an empty native-binding stub
and asserted exported classes/prototype methods. **This checks API shape only: no native browser
engine, browser behavior, screenshots or performance were tested.** No package, binary, browser,
dependency or framework was installed. This source snapshot is not a test of a later npm package.
Upstream describes the Node binding as experimental; its broader Python parity counts do not
establish Node-suite compatibility.

## Compatibility findings

| Repository requirement | Inspected Node surface | Consequence |
| --- | --- | --- |
| @playwright/test runner, test, expect, fixtures/device presets | No test, expect or devices exports | Browser-driving compatibility does not replace the test runner. |
| Locators, role selectors and uploads | No Page.locator, getByRole or setInputFiles | Existing input/result and accessibility workflows cannot run unchanged. |
| Pinned fixture routing and deliberate failure/retry cases | No Page/BrowserContext route or unroute | Equivalent data/error-path coverage is required. |
| Result downloads and event diagnostics | No Page.waitForEvent or Page.on; Node README lists downloads as unbridged | Scientific output verification and error collection need equivalent APIs. |
| Independent contexts, mobile/init configuration and tracing | newContext shim; no context addInitScript, storageState or tracing | Matching method names do not establish equivalent semantics. |
| Packaged desktop/remote browser sessions | No chromium.launchServer, connect or connectOverCDP | Existing desktop/browser-host validation needs another compatible path. |

The source explicitly says newContext() lacks storage/cookie isolation. normalizeContextOptions
retains only HTTPS-error and timeout options, not viewport/device/service-worker settings. This was
source inspection, not a live cookie-isolation experiment. The README's contexts limitation does not
mean the method is absent.

The wrapper provides launch, newPage, goto, click, fill, title, textContent, evaluate, screenshot
and close. Chromium-only support matches most current repository checks; it is not the primary
blocker.

Representative consumers are [NODDI browser reference](../../apps/noddi/e2e/reference.spec.js),
[brain-extraction fixture/error routing](../../apps/brain-extraction/e2e/app.spec.js), [interface
workflows](../../test/interface-workflows.smoke.mjs) and [desktop
workflows](../../scripts/desktop/workflows.mjs). These requirements protect outputs and failure
behavior rather than a framework preference.

## Bounded evaluation and decision

Keep current suites. A possible isolated pilot is a disposable standalone browser/agent script:
start one browser, visit a fixed local page, use selector click/fill, read a deterministic DOM
value, take a screenshot, close. Choose a named existing workflow first, and use a fresh browser per
trial rather than relying on context isolation.

Compare drivers with the same Chromium executable, local fixture and operation; verify DOM/artifacts
and timeout/failure behavior; separate startup from repeated interactions. Native-engine
compatibility, cleanup and actual screenshots still need validation. The API-surface probe does not
satisfy those runtime gates. Do not remove routing, upload/download, locator or scientific-output
checks to make a pilot pass.

Upstream speed/memory claims concern its own workloads. They establish no gain for these apps'
WASM/model computation, and orchestration results cannot be extrapolated to end-to-end scientific
workflows. No repository speedup, memory reduction, cost saving or framework migration is claimed.

Local probe: $TMPDIR/rustwright-node-surface-probe.cjs; result:
$TMPDIR/rustwright-node-surface-result.json. The pinned source links identify the inspected
implementation. The [scope
question](https://github.com/neurodesk/webapps/issues/605#issuecomment-6393396122) remains relevant
to selecting a pilot or migration plan; it does not block this feasibility finding.