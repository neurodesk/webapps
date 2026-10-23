# Dependency boundaries

Run `pnpm check:dependencies` after installing the workspace. The independent
`dependency-quality` pull request workflow checks the graph and its canary tests
without building apps, downloading models or launching a browser. CI always
runs workspace contracts; app tests follow the affected workspace dependencies.
Main runs retain GPU checks for affected apps; nightly and manual full runs
cover the complete catalog. The repository instructions describe CI scope.

The private `@neurodesk/dependency-quality` workspace owns dependency-cruiser
18.5.0, SWC 1.15.11 and enhanced-resolve 5.26.0. The optional parser is declared
inside this tooling dependency tree rather than replacing the repository compiler. pnpm also resolves electron-vite's optional SWC
peer, but dicompare does not register `swcPlugin`, so its compiler behavior stays
unchanged. The repository's TypeScript 7 compiler does not provide the compiler API supported by
dependency-cruiser. SWC parses TypeScript and TSX directly; the canaries exercise
an extensionless TypeScript import from TSX. Parser failures abort the check.
The exact SWC version uses its packaged native binding without a postinstall.

## Rules

`config/dependency-quality.mjs` classifies production sources and defines the
small existing runtime contracts. The checker enforces these rules:

- Shared package production code cannot import an app.
- An app cannot import another app's production code or worker.
- Component volume, pipeline and QSM helpers cannot depend on UI or DOM helpers.
  The core DOM builders cannot depend on UI, elements or viewer modules.
- Browser app sources and shared browser adapters cannot reach Node adapters,
  Node builtins or ONNX Runtime Node, even through a shared helper.
- Node adapters, CLI bins, Node drivers and desktop services cannot reach the
  browser runtime or component UI, elements, viewer and core DOM builders.
- Production imports must declare their package dependency in their owning
  workspace manifest. Relative imports into another workspace count too.
  Root dependencies and devDependencies do not satisfy a runtime dependency.
- Production sources cannot import test or tooling sources to bypass runtime rules.
- New production cycle edges fail, including literal worker URL edges. Explicit
  type-only imports stay outside runtime cycles and browser/Node reachability.
  Mixed imports and dynamic runtime imports retain their runtime edges. Inline
  `import { type T }` also retains an edge because workspaces use
  `verbatimModuleSyntax`; use declaration-level `import type` for an erased edge.
- Unresolved production imports fail unless an exact existing staging or remote
  runtime contract explains how the production build resolves them.
- No source, tooling included, may reach another workspace's or the root's
  `node_modules` by relative path or `new URL(..., import.meta.url)`, nor
  anchor `createRequire(new URL(...))` in another workspace (`foreign-node-modules`).
  Those copies exist only because of pnpm's layout; import the package by name and
  declare it in the owning workspace. Paths are read as URLs, so escapes and
  backslashes cannot hide one. A workspace's own `node_modules`, nested installs
  included, stays allowed, for example to stage `onnxruntime-web/dist` beside a
  verifier. To resolve through a dependency's own pins, anchor on the package by
  name: `createRequire(import.meta.resolve('@neurodesk/brain-extraction/mindgrab'))`.
- Tests, validation and build scripts declare every package they import by name
  in their own workspace (`undeclared-tooling`); the root's devDependencies only
  serve root scripts. The one exception is `@jest/globals` in a workspace that
  declares `jest`: Jest's runtime supplies that module and nothing installs it.

Tests, validation scripts, Vite and Playwright configs, verification utilities
and build scripts remain in the parsed graph, but do not become production roots
or cycle participants. In particular, reference comparisons may import app test
fixtures. Desktop's `browser-automation.js` is a Node adapter despite its name.
Mixed packages retain separate browser and Node adapters; the rules do not assume
that an entire scientific package is browser-only or Node-only.

The NIfTI reader's conditional `node:zlib` fallback is permitted only for that
module and builtin. Existing SynthSR, SynthStrip and SynthSeg browser adapters
may use their explicitly declared development runtime dependency so portable
Node installations omit it, as their deployment contracts require. SYNcro also
declares its bundled SynthSR, SynthStrip and registration helpers as build
dependencies. Its real production build is checked to bundle those helpers and
leave only nifti-reader-js and onnxruntime-node as runtime packages. Electron
host modules may use their existing devDependencies. These exceptions are exact
source/dependency pairs; a new adapter must establish its own contract.

## Runtime and generated code

Dependency-cruiser supplies import, export, require and literal dynamic-import
edges. The checker supplements literal `new URL(path, import.meta.url)` worker
and asset references and `import.meta.resolve`. Enhanced-resolve uses ESM import
conditions for asset resolution. Vite `?url`, `?inline`, `?raw` and `?worker`
queries resolve their underlying files and retain the original import identity.

`config/dependency-runtime-contracts.json` lists exact existing source/import
pairs whose files are staged before build, or whose remote assets are mirrored
for offline use. It names the staging or assembly mechanism for each pair. These
are resolution contracts, separate from the debt baseline. Resolution of workspace files uses the tracked and unignored Git inventory,
so ignored staging output cannot change the result. Unused contracts fail and
must be removed. Staging files locally does not change the baseline. Their byte checks, staging behavior, worker startup
and offline behavior remain covered by the existing runtime tests.

`generatedSources` excludes exact committed third-party bundles, Emscripten glue
and wasm-bindgen output from source analysis. Handwritten runtime wrappers remain
checked. Exact known generated mirrors map back to their canonical workspace sources, so
the graph follows their shared imports before a build. Arbitrary handwritten
vendor modules stay checked. Third-party node_modules are not traversed.
Scientific source files and reference comparison utilities are not excluded as
whole packages.

The check scans tracked and unignored JS, MJS, CJS, TS, TSX, MTS and CTS under
`apps/` and `packages/`. It does not analyze native Rust/C, HTML script tags,
CSS dependencies, arbitrary computed URLs, string-built dynamic imports or
third-party dependency internals. Every inventoried source must appear in the
graph, and an empty production inventory fails. Workspace symlinks explicitly
resolve to canonical package paths. It cannot prove browser API compatibility or
portable package contents; packaging, runtime and browser tests own those checks.

## Existing findings and follow-up work

`config/dependency-baseline.json` is empty. Findings remain identified by rule,
source and target. New findings fail even when an old finding vanishes and the
total stays unchanged. Removing a finding also requires deleting its baseline
entry, so resolved debt cannot silently return later.

The initial 30 findings were resolved with explicit app/package declarations,
three explicit dicompare type imports, and extraction of NeSVoR's unchanged pure
reference validator. The browser continues to export the same validator and
preset; its worker imports the pure helper directly. No upstream source pin or
scientific behavior changed.

### Development tooling (2026-10-12)

Test, validation and build imports stay outside the runtime dependency rule but
are declared where they are used, so a workspace's tests and verifiers resolve
from its own `node_modules`. Declarations reuse the versions the root already
resolves (`@playwright/test` and `playwright` 1.64.0, `jsdom` 24.1.3, `ajv`
8.20.0, `ajv-formats` 3.0.1, `yaml` 2.9.0, `onnxruntime-node` 1.29.0, Vite
5.4.21 for NeSVoR), so the
change added lock importer entries and no new packages. These were added after
an inventory of every non-production import:

| Workspace | Declared tooling | Importers |
| --- | --- | --- |
| `packages/nesvor` | `@playwright/test`, `vite` | GPU and ONNX verifiers; `verify-workflow.mjs` imported Vite from `apps/nesvor/node_modules` |
| `packages/components` | `@playwright/test`, `jsdom` | unit tests, `scripts/test-elements-browser.mjs` |
| `packages/lcmodel` | `jsdom` | `test/report.test.js` |
| `packages/desktop` | `ajv`, `ajv-formats` | `neuroflow/generator.mjs` |
| `packages/synthstrip`, `apps/synthsr` | `onnxruntime-node` | numerical tests that loaded SynthSR's copy |
| `packages/{calmar,seedseg,syncro,topofit,vesselboost}` | `@playwright/test` | browser reference scripts; SYNcro's benchmark loaded `apps/syncro`'s copy |
| `apps/browserqc` | `@playwright/test`, `jsdom` | e2e specs, `test/rate.test.mjs` |
| `apps/{deface,mri2vid,easy-mp2rage,niimath}` | `@playwright/test` | e2e specs and config |
| `apps/{qsmbly,seedseg,dicompare}` | `@playwright/test` (and `yaml` for QSMbly) | e2e specs and config; kept as an adaptation in `upstream.json` |
| `apps/white-matter-lesions` | `playwright` | `validation/browser-memory.mjs` |

Dev-only tools stay out of runtime `dependencies`, so portable command lines
and shipped bundles are unchanged; SYNcro's bundled-helper contract still passes
`packages/syncro/test/build-closure.test.js`. Root scripts such as the interface
audit and the desktop smoke test keep using the root's tooling.

Catalog commands use the repository's shared orchestration. Static apps'
`test:e2e` scripts call `test/examples.smoke.mjs`, which imports the root's
Playwright installation and registry helpers. App builds that use
`scripts/lib/vite-app-config.mjs` read the registry through the root's `yaml`.
`scripts/generate-neuroflow.mjs` also reads that registry, while the desktop
workspace's schema generator resolves Ajv from its own declared dependencies.
Run `pnpm install --frozen-lockfile` at the repository root before these catalog,
build and example commands. Their existing CI build and browser jobs install
the full repository before invoking the app commands. Direct workspace tests
and NeSVoR's numerical workflow verifier resolve their locally declared tools.

To inspect current findings, run
`pnpm check:dependencies --report "$TMPDIR/dependency-findings.json"`.
The report command never rewrites the baseline. Review every proposed baseline or
runtime-contract edit alongside the code establishing its reason. Do not generate
a larger baseline merely to pass CI.
