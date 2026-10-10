# Dependency boundaries

Run `pnpm check:dependencies` after installing the workspace. The independent
`dependency-quality` pull request workflow checks the graph and its canary tests
without building apps, downloading models or launching a browser. Existing CI
continues to run its full catalog checks.

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
  Mixed imports and dynamic runtime imports retain their runtime edges.
- Unresolved production imports fail unless an exact existing staging or remote
  runtime contract explains how the production build resolves them.

Tests, validation scripts, Vite and Playwright configs, verification utilities
and build scripts remain in the parsed graph, but do not become production roots
or cycle participants. In particular, reference comparisons may import app test
fixtures. Desktop's `browser-automation.js` is a Node adapter despite its name.
Mixed packages retain separate browser and Node adapters; the rules do not assume
that an entire scientific package is browser-only or Node-only.

The NIfTI reader's conditional `node:zlib` fallback is permitted only for that
module and builtin. Existing SynthSR, SynthStrip and SynthSeg browser adapters
may use their explicitly declared development runtime dependency so portable
Node installations omit it, as their deployment contracts require. Electron
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
are resolution contracts, separate from the debt baseline. Staging files locally
does not change the baseline. Their byte checks, staging behavior, worker startup
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
third-party dependency internals. It cannot prove browser API compatibility or
portable package contents; packaging, runtime and browser tests own those checks.

## Existing findings and follow-up work

`config/dependency-baseline.json` contains 30 individual findings, each identified
by its rule, source and target. New findings fail even when an old finding
vanishes and the total stays unchanged. Removing a finding also requires deleting
its baseline entry, so resolved debt cannot silently return later.

| Findings | Follow-up |
| --- | --- |
| 10 dicompare context/hook/helper cycle edges | Extract shared types and pure helpers from React context modules. Preserve upstream import adaptations. |
| 3 NeSVoR browser/worker/reference-workflow cycle edges | Separate the worker protocol and browser orchestration. These edges span a worker URL rather than one ESM execution context. |
| 3 dicom2vid and easy-mp2rage shared component imports | Declare `@neurodesk/webapp-components` in their app manifests. |
| 3 SYNcro app imports of its undeclared pipeline workspace | Establish an explicit app build dependency on `@neurodesk/syncro`. |
| 5 SYNcro package imports of SynthSR, SynthStrip and registration sources | Audit the bundled portable CLI before choosing build or runtime declarations. Adding browser-heavy runtime dependencies would change portable installation behavior. |
| 6 NeSVoR package imports of SynthSR volume helpers and shared fetchModel | Declare the appropriate workspace dependencies or provide a smaller pure helper dependency. |

Several test and validation imports also use root development tooling, notably
Playwright and jsdom in app/package tests and Ajv in the desktop contract generator.
They are intentionally outside the runtime dependency rule. A follow-up can declare
local devDependencies where independent workspace testing or publishing requires
them. `packages/nesvor/src/gpu/verify-workflow.mjs` additionally imports Vite from
`apps/nesvor/node_modules`; replace that with a declared Vite devDependency.

To inspect current findings, run
`pnpm check:dependencies --report "$TMPDIR/dependency-findings.json"`.
The report command never rewrites the baseline. Review every proposed baseline or
runtime-contract edit alongside the code establishing its reason. Do not generate
a larger baseline merely to pass CI.
