# Unused code reports

Run `pnpm quality:unused` after `pnpm install --frozen-lockfile --ignore-scripts`.
No app builds, model downloads, native compilers or browser runtimes are required.
The independent `unused-code` workflow runs on every pull request and main push.
It writes a GitHub job summary and uploads `quality-artifacts/unused-code` with
`knip.json`, `summary.md` and `diagnostics.log`. Scan warnings also appear in the
summary so incomplete analysis is visible without downloading diagnostics.

Findings are candidates for review. They do not fail CI yet. Invalid configuration,
configuration modules that throw, scanner crashes, missing executables and invalid
JSON output fail the job. The pinned Knip CLI's `--no-exit-code` suppresses findings
only; the adapter requires a successful process and a valid report. Tests exercise
both successful canary findings and real configuration failures.

## Coverage and entry rules

`knip.config.mjs` discovers every pnpm workspace with `@manypkg/get-packages`.
Each workspace gets a project glob covering JavaScript and TypeScript sources,
including `.mts` and `.cts`;
new workspaces receive the same coverage automatically. A tracked-file coverage
test rejects source files outside configured projects and explicit exclusions.
Ordinary source files are not all entries. The following roots account for externally invoked code:

- Local script tags in `index.html` and `web/index.html`, including static apps.
- Package exports, bins and framework configurations discovered by Knip plugins.
  Published `dist` exports also register matching `src` files without a build.
- Tests, end-to-end fixtures, validation programs, bin programs, tools and scripts.
  `scripts/lib` remains ordinary library code, reachable through callers.
- Site shell, landing page and theme injected by the site build.
- Explicit workers referenced by string URLs, Electron and Cloudflare entries,
  component showcase and template mains, and the prebuilt FreeBrowse entry.
- Shared JavaScript sources named in `runtime-assets/manifest.json`.
- NeSVoR verification programs and surfannotate's icon renderer invoked manually.

Knip follows imports, literal dynamic imports and `new URL(..., import.meta.url)`
worker references. New runtime modules loaded through constructed URLs need an
explicit entry. Literal entries are checked for existence during configuration
loading. Local HTML scripts are parsed as HTML, with served web-root resolution;
unknown missing scripts fail configuration. Known generated HTML runtimes have
exact per-app exceptions in the configuration and stay excluded after local staging. Dist APIs map to JavaScript or
TypeScript sources and fail if a source mapping is missing.
Add a narrowly named root and explain its caller here.

Generated distributions, node_modules, vendor copies, public runtime assets and
validation result archives are excluded. Project negations are checked against
the documented shared exclusions and exact per-workspace exceptions; a new
exclusion cannot silently hide source files. Generated model catalogs are excluded.
The committed easy-mp2rage WASM glue and vesselboost preprocessing glue are excluded
in their own workspaces. QSMbly's imported NiiVue copy is excluded. Declaration
files are excluded from unused-file suggestions; unused types remain reported.
The root project includes native JavaScript demos under `exes`. The canonical
`templates/app-template` contains scaffolding placeholders and is checked by the
app-generator tests instead of Knip. `docs/architecture/examples` holds historical
source snapshots and is excluded. Other new root source directories fail the
tracked-file coverage test until they are configured. Public entry exports remain protected
because external users can import them.
Exports used within their own file are not suggested for removal.

The report includes unused files, exports, types, duplicate exports, dependencies
and devDependencies. Build staging through computed paths and vendored shared
pipelines can produce dependency candidates even when a package is required.
Check package scripts and staging code before removing one. Source parsed only
at runtime inside an HTML string or `page.evaluate` can also require manual review.

QSMbly, SeedSeg and dicompare remain upstream-owned. Their findings are visible,
but any cleanup must respect `upstream.json` and the upstream synchronization
contract. Do not mass-delete their findings from this report.

Review each candidate with a repository-wide reference search and relevant unit
or workflow checks. Also check runtime inventories, release version synchronization,
published exports and source strings in browser tests before deleting a file.
Keep fixes separate from reporting changes so each deletion has reviewable evidence.
