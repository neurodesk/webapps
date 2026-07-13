# NeuroDesk Webapps — Architecture & Migration Proposal

**Status:** Superseded by [ADR-0001](../adr/0001-composite-static-site.md) · **Date:** 2026-07-11 · **Owner:** @bollmann.steffen

> The implementation now contains all seven catalog apps and builds one composite
> site at `webapps.neurodesk.org/<app>/`. The material below is retained as the
> reviewed proposal history; its four-app scope and one-project-per-app deployment
> are no longer current.

**Decided:** deploy host is **Cloudflare Pages — one project per app from this monorepo** (open
decision #1 resolved by @bollmann.steffen). The GitHub Pages single-artifact fallback is dropped.

Goal: a maintainable, scalable structure for the NeuroDesk browser webapps that lets us
**reuse components across apps**, makes it **very easy to add a new app**, and treats
**usage statistics** as a shared, privacy-safe concern.

> **Revision note.** Revision 1 proposed the right shape (one monorepo, pnpm workspaces, Turbo,
> per-app Vite, a MuscleMap pilot, a scaffold command, no app-branches/submodules) but shipped
> example files that would race on deploy, scaffold a broken app, mis-scope the inventory, and
> describe a statistics app that cannot exist as a static page. This revision fixes those.
> **The example files are illustrative contracts, not drop-in production code** — each must pass the
> CI gates described in §9 before it is trusted.

---

## 1. Current state (corrected inventory)

The hosted page lists **seven** webapps, and they are **not** homogeneous. Treating them as five
identical vanilla/ONNX apps was the central factual error in revision 1.

| App | Repo / owner | Stack | Notes |
| --- | --- | --- | --- |
| MuscleMap | `neurodesk/musclemap-webapp` | vanilla JS · ONNX · NiiVue | classic `importScripts` workers; IMF/Dixon-fat/CSV metrics; COI service worker |
| VesselBoost | `neurodesk/vesselboost-webapp` | vanilla JS · ONNX · NiiVue · **Rust/WASM** preproc | 3D UNet |
| Spinal Cord Toolbox | `neurodesk/spinalcordtoolbox-webapp` | vanilla JS · ONNX · NiiVue | |
| CALMaR | `neurodesk/calmar-webapp` | vanilla JS · ONNX · NiiVue | many pipelines, atlas logic, spatial guards |
| QSMbly | collaborator-owned | **Rust/WASM** build; Jest + Cargo test suites | not vanilla-only |
| SeedSeg | collaborator-owned | imaging webapp | different ownership |
| dicompare | collaborator-owned | **React · TypeScript · Vite · Pyodide · Electron** | fundamentally different build/runtime |

Shared library (**prototype, not yet a verified source of truth**):

- `@neurodesk/webapp-components` v0.1.2 — MIT, framework-free ESM. **Versioned in GitHub but not
  published to npm** (its release workflow only runs `npm pack --dry-run`).
- Modules: `core/ file-io/ inference/ mask/ pipeline/ ui/ viewer/ volume/`; per-app plugins
  (synthstrip, sct, vesselboost, musclemap, lesion-network-mapping, qsm); internal `templates/`.
- Its **app-specific plugins have already drifted** from the deployed apps (e.g. the shared
  lesion-mapping plugin lags CALMaR's current pipelines; the shared `MetricsSummary` does not cover
  MuscleMap's IMF/Dixon-fat/CSV output; the shared executor defaults to **module** workers while the
  apps ship **classic `importScripts`** workers).

**Correct problem statement:** extraction is *partially* done and drifting. The task is not "flip
the switch on adoption"; it is "re-extract in order of confidence, behind parity tests, sharing
controllers/contracts while each app keeps its scientific internals."

---

## 2. Scope decision

**This RFC's migration is scoped to the four closely-related org-owned imaging apps first**
(MuscleMap, VesselBoost, SCT, CALMaR), with QSMbly joining once its Rust/WASM build is expressed as
a per-app build contract. **The repository is *designed* to accommodate all seven** — including
React/TS/Pyodide/Electron (dicompare) and collaborator ownership — but SeedSeg and dicompare are
**not** in the initial cut. They join after a Phase 0 ownership/licensing agreement (§8) and only if
their maintainers opt in. Nothing here forces dicompare into vanilla JS or forces a single build
system; the workspace requires only that each app expose `build`/`dev`/`test` scripts.

---

## 3. Options considered

| Approach | Reuse | Add an app | Independent deploy | Cross-app change | Verdict |
| --- | --- | --- | --- | --- | --- |
| Branch-per-app in one repo | ✗ can't import across branches | painful | ✗ | merge hell | reject |
| Git submodules for components | ⚠️ pinned SHAs, 2-step commits | ceremony | ✓ | two repos in lockstep | reject |
| Polyrepo + published npm lib | ✓ but publish→bump→update loop | new repo each time | ✓ | multi-repo, versioned | acceptable |
| **Monorepo + workspaces** | ✓ live local imports | ✓ scaffold a folder | ✓ per-project deploy | ✓ atomic, one PR | **recommended** |

Branch-per-app and submodules are rejected for the reasons in revision 1 (branches can't `import`
across each other and turn shared changes into cross-branch cherry-picks; submodules pin SHAs and
force two-repo lockstep commits). Those rejections stand and are the least controversial part.

---

## 4. Recommended architecture

```
neurodesk-webapps/                     (one repo, one main branch)
├── packages/
│   ├── components/                    @neurodesk/webapp-components  (moved in, re-extracted incrementally)
│   ├── analytics/                     typed telemetry allow-list + emitter (§7)
│   └── wasm-preproc/                  optional shared Rust/WASM (vesselboost/qsmbly) if it converges
├── apps/
│   ├── musclemap/                     keeps its scientific workers + IMF/Dixon/CSV renderers
│   ├── vesselboost/
│   ├── spinalcordtoolbox/
│   ├── calmar/                        keeps its pipelines/atlas/spatial guards
│   └── qsmbly/                        Rust/WASM build contract
├── templates/
│   └── app-template/                  SELF-CONTAINED scaffold (imports @neurodesk/webapp-components/*)
├── registry/apps.yml                  SOURCE OF TRUTH: app id, domain, CF project, GA4 id, manifest
├── models/                            manifests only — NO checked-in .onnx (§8)
├── scripts/new-app.mjs                pnpm new-app <name> (also registers the app in registry/apps.yml)
├── .changeset/                        independent versioning config (§6)
├── .github/workflows/{ci,deploy}.yml
├── pnpm-workspace.yaml · turbo.json · package.json
```

### How each goal is met (with the review's constraints baked in)

- **Reuse** — apps import from `@neurodesk/webapp-components` (resolved to local source via
  `workspace:*`), so component + consumer changes land in one atomic PR. But we share **controllers
  and contracts**, not scientific internals: workers, metric renderers (IMF/Dixon/CSV), settings,
  and pipeline definitions **stay in each app**. Extraction proceeds byte-identical-first, behind
  parity tests (§5).
- **Easy to add an app** — `pnpm new-app <name>` copies the **self-contained** `templates/app-template`
  and registers the app in `registry/apps.yml`. A CI **generator-contract** job scaffolds a throwaway
  app and proves it installs, lints, unit-tests, and **builds**; a **browser** job runs the app's
  Playwright test (app boot + `crossOriginIsolated` + worker load).
- **Statistics** — a scheduled, authenticated GA4 pipeline emits sanitized aggregate JSON that a
  static `apps/stats` renders. Telemetry is a typed allow-list that **validates values (type, enum,
  length, app/version pattern; no nested objects)** and **prohibits patient-derived data**; it is
  **off unless consent is granted and Do-Not-Track is unset**, and GA4 is not loaded when disabled
  (§7). No "analytics for free."

### Tooling
- **pnpm workspaces** for linking; **Turbo** for affected-only, dependency-aware CI (§9);
  **Vite** as each app's *build contract* (not a mandate to use React — dicompare already does, the
  imaging apps don't). Vite replaces ad-hoc `setup.sh`/`run.sh` but the output stays fully static.

---

## 5. Shared/app boundary — extract in order of confidence

Do **not** replace app workers and specialised UI wholesale. Extract in tiers, each gated by a
**parity test** (same input NIfTI → byte- or tolerance-identical output vs. the currently deployed app).

| Tier | Extract to library | Keep in app |
| --- | --- | --- |
| 1 — byte-identical | ModalManager, ProgressManager, ConsoleOutput, basic DICOM→NIfTI (`dcm2niix`), NIfTI read/write utils | — |
| 2 — contracts | Controller *interfaces* (FileIO, Viewer, Inference executor **that supports classic `importScripts` workers**), NiiVue viewer wiring | app-specific worker payloads |
| 3 — hard, maybe never | generic pieces of metrics/pipeline UI | **MuscleMap** IMF/Dixon-fat/CSV renderer; **CALMaR** pipelines/atlas/spatial guards; all **scientific workers**; per-app settings |

Explicit worker rule: the shared inference executor must **support classic `importScripts` workers**
(the apps' current form), not default to module workers. Apps keep their scientific worker code;
the library provides the executor/lifecycle contract around it.

---

## 6. Versioning & releases (independent per app)

- **Changesets with independent versioning.** Private packages are versioned too
  (`.changeset/config.json` → `privatePackages: { version: true, tag: false }`); apps carry a real
  `version` and are `"private": true` for deploy but still release-tracked.
- **No single global `v*` tag.** Use **per-app tags** (`musclemap-v1.3.0`) and **path-filtered**
  workflows so an app releases without dragging the others.
- **Preserve staging vs production.** `main` → staging deploy for changed apps; **app tag** →
  production deploy for that app. This mirrors the existing model instead of "deploy everything on
  every push to main."

---

## 7. Statistics — corrected architecture

A browser-only `apps/stats` **cannot** "read the GA4 stream": GA4 reporting needs authenticated Data
API access, and credentials must never live in a public static app. Correct pipeline (mirrors
Neurodesk's existing scheduled metrics generator):

```
GA4  →  authenticated scheduled workflow (secrets in CI)  →  sanitized aggregate JSON (committed/published)  →  static apps/stats reads JSON
```

**Typed telemetry allow-list** (`packages/analytics`, supplied in `examples/`). Only these leave the
browser, all non-identifying:

- app id, app version, event name (from a fixed enum), coarse timing buckets, boolean feature flags,
  browser/OS class, run success/failure.

**Values are validated, not just keys.** `sanitize()` drops any prop that is a non-primitive
(object/array/null), fails its per-key check (exact enum membership, `app`/`app_version` regex,
string length ≤ 32), or is unknown; unknown event names throw. Unit tests in
`examples/packages/analytics/test/` cover these cases.

**Consent & Do-Not-Track.** Telemetry is **off by default**: `track()` no-ops and GA4 is never even
loaded unless consent is stored **and** `navigator.doNotTrack`/GPC is unset. Consent state is surfaced
in each app's UI.

**Explicitly prohibited** (never emitted, never logged): filenames, DICOM metadata/tags, image
dimensions, voxel values, any scientific measurement or segmentation, screenshots, and free-text
logs. These are patient-data applications; telemetry is an allow-list, not a denylist.

---

## 8. Assets, licensing & ownership — a real Phase 0

- **Externalize models before importing histories.** pnpm does not fix large checked-in `.onnx`
  blobs. Define an **immutable model manifest** per app (`models/<app>.manifest.json`: `url`,
  `sha256`, `bytes`, `license`, `preprocessing_contract`) and fetch on demand (Hugging Face /
  releases), as CALMaR already does. Do **not** `git subtree` full histories that carry large
  binaries — filter them out first.
- **Licensing.** Several source repos lack a top-level licence. Resolve licences (apps + models +
  atlases) before consolidating; a monorepo with mixed/absent licences is worse than the status quo.
- **Ownership.** QSMbly, SeedSeg, dicompare are collaborator-owned. Consolidation needs their
  maintainers' consent and a contribution/ownership agreement; until then they stay external and are
  only *referenced* by the deploy/registry, not moved.

---

## 9. CI/CD — corrected

### Build/test
- **Affected-only.** CI runs `turbo run … --filter=…[origin/main]` with **remote cache**, so a fresh
  runner does *not* execute the whole graph (revision 1's `ci.yml` did).
- **Per-package test tasks, not global `node --test`.** Each package declares its own `test`:
  MuscleMap runs its **pytest** suite, QSMbly runs **Jest + Cargo**, JS packages run their unit
  tests. Turbo fans out to each; nothing is silently skipped.
- **Deploy through Turbo** (`turbo run build --filter=<app>`), not raw `pnpm --filter … build`, so
  caching and task deps apply.

### Deployment — Cloudflare Pages, one project per app (decided)
Revision 1 called `deploy-pages` once per matrix job, all targeting the **same** repo Pages site;
they race and overwrite. The committed model instead gives **each app its own Cloudflare Pages
project**, deployed by CI via **Direct Upload** (`wrangler pages deploy`):

- One project per app (`musclemap`, `calmar`, …), each mapped to its own custom domain
  (`musclemap.neurodesk.org`). Independent deploys, no shared site, no racing.
- CI builds through **Turbo** (affected-only, cached) and uploads `apps/<app>/dist` to that app's
  project. Direct Upload — not Cloudflare's dashboard Git integration — so the build is reproducible
  in-repo and Turbo caching applies.
- **Staging vs production via the project's production branch.** Each project's production branch is
  set to `production` (which normally receives no commits). Pushes to `main` deploy as **preview =
  staging**; a per-app tag `foo-v*` triggers a **production** Direct Upload with `--branch=production`.
  So `main` is always staging and production is tag-gated, per app.
- See [`examples/deploy.cloudflare.yml`](./examples/deploy.cloudflare.yml) (the CI workflow),
  [`examples/deploy.cloudflare.md`](./examples/deploy.cloudflare.md) (project + secrets setup), and
  [`examples/app-template/public/_headers`](./examples/app-template/public/_headers) (production
  COOP/COEP served at the edge — shipped inside every scaffolded app so it actually reaches `dist/`).

Required repo secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` (plus `TURBO_TOKEN`/`TURBO_TEAM`
for remote cache). Each app ships a `wrangler.toml` naming its Pages project.

### Cross-origin isolation in production (not just dev)
Vite's `server.headers` COOP/COEP apply only to the **dev** server. Production must serve COOP/COEP
via the host (Cloudflare `_headers`) **or** ship the existing **COI service worker**
(`coi-serviceworker.js`, already in MuscleMap). A **deployed** smoke test must assert
`crossOriginIsolated === true`, workers load, and threaded ONNX executes — otherwise inference
silently falls back or breaks.

---

## 10. Concrete artifacts

Under [`examples/`](./examples/) — **contracts to validate, not trusted production code**. The JS,
JSON and YAML all parse, the analytics unit tests pass, and the generator has been run end-to-end
(scaffolds a complete app + updates the registry); the browser/e2e behaviour is asserted by CI:

- `pnpm-workspace.yaml`, `root-package.json` (root `wrangler`/`@playwright/test`), `turbo.json`
- `registry/apps.yml` — **source of truth** (app id · domain · Cloudflare project · GA4 id · manifest)
- `ci.yml` — affected via `TURBO_SCM_BASE/HEAD` (event-specific SHAs) + generator-contract + browser jobs
- `deploy.cloudflare.yml` — Turbo build + `wrangler pages deploy` per app; affected-with-dependents
  discovery intersected with the registry; staging/prod split; `workflow_dispatch` + tag both validated
- `deploy.cloudflare.md` — project/secrets setup
- `new-app.mjs` + `app-template/` — **self-contained** scaffold (imports `@neurodesk/webapp-components/*`
  and `@neurodesk/analytics`); ships `wrangler.toml`, `public/_headers`, a Node unit test and a
  Playwright browser test; registers the app in `registry/apps.yml`
- `packages/analytics/` — supplied package: value-validating allow-list + consent/DNT gating + tests
- `changeset-config.json` — independent versioning incl. private packages
- `models.manifest.json` — externalized model contract (MuscleMap's real 2D, native-z contract)

---

## 11. Migration plan

### Phase 0 — Licensing, ownership, assets (blocking)
Resolve licences on all in-scope repos/models/atlases; get collaborator consent for QSMbly/SeedSeg/
dicompare (or defer them); define model manifests and strip large binaries from any history to be
imported. Stand up the empty monorepo (root config, CI, Changesets) and create the Cloudflare Pages
projects: one per in-scope app, each with production branch set to `production` and its
`*.neurodesk.org` custom domain; add `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` repo secrets.

### Phase 1 — MuscleMap pilot (behind parity tests)
1. Import `web/` history **without** `.onnx` blobs; add `models/musclemap.manifest.json`.
2. Move `webapp-components` into `packages/components`.
3. Extract **Tier 1 only** (modal, progress, console, DICOM convert, NIfTI utils); replace in
   MuscleMap; assert parity (`scripts/compare_inference.py` + output-diff) before deleting originals.
4. Keep MuscleMap's classic workers, IMF/Dixon-fat/CSV renderer, and settings in the app.
5. Add `packages/analytics` allow-list; wire MuscleMap; confirm no prohibited fields emit.
6. Swap `setup.sh`/`run.sh` for Vite; ship COI service worker (or Cloudflare `_headers`); add the
   deployed `crossOriginIsolated` smoke test.
7. Deploy via the `musclemap` Cloudflare Pages project (tag `musclemap-v*` → production); verify
   `musclemap.neurodesk.org` parity and that the deployed `crossOriginIsolated` smoke test passes.

### Phase 2 — VesselBoost, SCT, CALMaR, then QSMbly
Repeat Phase 1 per app, moving up the tiers only as parity holds. CALMaR keeps its
pipelines/atlas/spatial guards; VesselBoost/QSMbly express their Rust/WASM as a per-app build (shared
`packages/wasm-preproc` only if it genuinely converges). Each app gets its own Cloudflare project.

### Phase 3 — Statistics
Ship the scheduled GA4→JSON workflow and the static `apps/stats` reading sanitized aggregates.

### Phase 4 — Optional: SeedSeg, dicompare
Only with owner consent. dicompare joins as a **React/TS/Vite/Pyodide/Electron** app — proof the
workspace tolerates heterogeneous stacks — sharing contracts/telemetry, not vanilla-JS internals.

### Adding a new app afterwards
```
pnpm new-app cerebellum        # self-contained scaffold, wired to the lib + analytics allow-list
pnpm --filter cerebellum dev
# open a PR — CI installs, builds, tests, and browser-smoke-tests the scaffold; deploy adds a project
```

---

## 12. Open decisions for @bollmann.steffen

1. ~~**Deploy host**~~ — **Decided: Cloudflare Pages, one project per app** (keeps `*.neurodesk.org`).
2. **Initial scope** — four org imaging apps now (recommended) vs. push for all seven up front?
3. **Collaborator apps** — pursue consent for QSMbly/SeedSeg/dicompare now, or design-only for later?
4. **Publish the library to npm** eventually, or keep it workspace-internal indefinitely?
5. **Models** — Hugging Face vs. GitHub Releases as the immutable model host?
6. **Production branch name** — `production` as the tag-gated production target (as written), or wire
   production straight off `main` and use previews only for PRs?
