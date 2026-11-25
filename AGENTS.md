# Repository instructions

This repository stores source code only. Large validation datasets and models belong on [https://huggingface.co/datasets/neurodeskorg/webapps](https://huggingface.co/datasets/neurodeskorg/webapps). Every app is versioned `MAJOR.MINOR.YYYYMMDD`: the patch is the UTC release date (e.g. `0.1.20260808`). Describe changes in a changeset (`pnpm changeset`), then run `pnpm release`, which sets the date versions, writes changelogs and synchronises embedded version strings (`scripts/lib/app-versions.mjs`); `test/app-versions.test.mjs` rejects any other scheme. An app version written into app, package or site source is read from `package.json` or registered in `EMBEDDED_VERSION_SITES`; the same test fails on a `0.0.0` under a version key or a date in the package's own MAJOR.MINOR found anywhere else (JSX and HTML outside `<script>` are not scanned). Keep scratch files off `/tmp`: `TMPDIR` points at the storage volume and turbo passes it through.

Every remote URL the apps or the offline bundle fetch (`registry/offline-assets.sources.json` and its lock, `models/*.manifest.json`, `apps/*/examples.json`) must be immutable: a Hugging Face commit, an exact npm version, a release asset or a commit URL. Mirror anything else to the dataset and pin it; `test/offline-asset-pins.test.mjs` rejects the rest.

pnpm's `minimumReleaseAge` blocks a dependency version for 24 h after it is published. To adopt a fresh release (e.g. a new `@niivue/niimath`) sooner, add that exact version to `minimumReleaseAgeExclude` in `pnpm-workspace.yaml`.

## Memory and scoped instructions

Before editing under `apps/<id>/`, `packages/<id>/`, or `exes/`, read any `AGENTS.md` (or `AGENT.md`) in that directory:

- Per-app rules live in `apps/<id>/AGENTS.md` (and `apps/vesselboost/AGENT.md`), not in this root file.
- Shared subsystem rules live in [packages/runtime-support/AGENTS.md](packages/runtime-support/AGENTS.md) (FreeBrowse viewer, `dcm2niix`), [packages/node-drivers/AGENTS.md](packages/node-drivers/AGENTS.md) (MindGrab, niimath CLI drivers), [packages/components/src/webmcp/AGENTS.md](packages/components/src/webmcp/AGENTS.md) (full WebMCP contract), [exes/AGENTS.md](exes/AGENTS.md) (native executables), and [exes/compute-server/AGENTS.md](exes/compute-server/AGENTS.md) (NeSVoR and `neurodesk-compute`).
- Keep the four memory layers separate: permanent invariants stay in scoped `AGENTS.md` files and contract tests; catalog truth stays in `registry/`; point-in-time evidence and ADRs stay in `docs/`; transient work state, rollout queues and discovered follow-ups stay out of `AGENTS.md` and off `main` (no CI job, build or test may ever depend on external agent memory).

## Interface changes and new applications

Before changing UI, adding controls, or scaffolding an app, read [the design system](docs/architecture/design-system.md) and [the interface standard](docs/architecture/interface-standard.md). The design system sets the look (Inter, neutral greys, the logo green for action only) and the shared vocabulary; the app template is its reference.

- Keep `support_status` as internal registry metadata, with no Experimental badge on webapp cards. `test/landing-page.test.mjs` and the catalog checks in `test/mobile-layout.smoke.mjs` enforce this.
- Build every sidebar, viewer, console, status bar and dialog from the classes in `@neurodesk/webapp-components/styles/imaging-workspace.css` and the custom elements and native builders in `@neurodesk/webapp-components/ui` (`createFileField`, `createViewerToolbar`, `createConsole`, `createInfoDialog`, `createResultList`). Start from `templates/app-template`, which is the complete canonical layout.
- Do not write app CSS for those regions, hardcode colours, override `--nd-color-*` tokens, set `color-scheme`, or add `<dialog>` markup. If the vocabulary lacks something, add it to the shared stylesheet with a test, then use it. `test/design-system.test.mjs` fails on each of these.
- Keep sources readable: one rule or statement per line. Minified app HTML, CSS or JS hides drift from review.
- About and Cite content is data in `registry/app-information.yml` (the lightNIIng ecosystem statement and link live under `shared`) (packages under the hood, a paper per implemented method, builder credits). The shared shell renders it; apps never write citation markup. When an app gains a method, add its paper there and to `test/app-information.test.mjs`.
- Keep one shared application bar. Register app-specific About, Cite and Privacy handlers through the shell's control contract. If an app ships a command-line package, register its Standalone instructions through the optional shell control instead of placing them in the workflow sidebar.
- Closed class-toggled dialogs must synchronize inert and aria-hidden state, not merely become transparent. Keep this state in the shared `ModalManager`/`dialogFocus` lifecycle so transitions remain intact; `test:mobile` checks About/Privacy/Cite accessibility and focus at phone and wide viewports.
- Keep the current task visible. Put optional settings, technical logs and inactive output controls in accessible collapsible sections.
- Place technical logs in a collapsed console below the viewer, following QSMbly's `console-container` disclosure pattern. Keep Copy and Clear actions in the console header.
- Open straight into the workspace. Do not add start pages, hero sections, landing overlays or welcome modals; an introduction is one paragraph in the About template.
- Show every live status update in the bottom bar, `footer#status`: the message, a native `<progress>`, elapsed time and a × that appears only while the run can be cancelled. Drive it with `ProgressManager` from `@neurodesk/webapp-components/ui` (`begin`, `setProgress`, `end`, `reset`). It starts at "Drag and drop files". Never put status, progress or a second log in the sidebar, and do not add a static footer.
- Keep visible help to 90 characters. Put longer explanations in an `.nd-info-icon` tooltip beside the label (`renderInfoIcon`, `bindInfoTooltips`) or in About. No subtitle paragraphs under section titles, no numbered step badges, no instructions that repeat a button's label.
- Give each sidebar one `.nd-btn-primary`. Every other action, including per-step Run buttons, is secondary; the footer × is the only cancel.
- `test/design-system.test.mjs` checks these rules in source for every app, whatever its shell; `pnpm audit:interfaces` checks them in the rendered page on desktop and phone.
- Do not write drop code. The shell's page drop (`bindPageDrop`) sets the primary input's files and fires `change`; an app whose viewer loads drops itself marks it `data-drop-target`, and an input that appends to a list carries `data-appends`, clears on `nd-replace` and fires `nd-files` (`detail.files`) when its app removes entries, so Undo restores the list as it was.
- Do not write handoff code either. DICOM View's "Open in another webapp" menu lists the registry's apps, and the shell opens what it sends through the receiving app's inputs as a page drop would. `handoff` in `registry/apps.yml` says what an app receives: the NIfTI image (default), `dicom` (the series' files) or `none` (left out of the menu). An app that cannot take files through a classified input receives them itself (`takeHandoff`) and marks its body `data-neurodesk-handoff-receiver`, as dicompare and White matter lesions do.
- Reuse shared layout, spacing and control components. Preserve input values when sections close.
- Before completing UI work, run `pnpm audit:interfaces`, `pnpm test:mobile` and `pnpm test:interface-workflows` against a fresh production build. They check every app; `SMOKE_APPS=a,b` narrows them to those apps. Review desktop and phone screenshots and exercise the changed workflow. The interface standard defines the review criteria and the audit's limits.

For catalog-wide work, use [the interface audit](docs/architecture/interface-audit.md) to track remaining changes per app. Update its findings when resolving them.

## Catalogue sites

Apps are served from several hosts: `webapps.neurodesk.org` (catalogue `neuro`, GitHub Pages), `mskapps.sciget.org` (`msk`), `microscopyapps.sciget.org` (`microscopy`), `preclinicalapps.sciget.org` (`preclinical`) and `dermatologyapps.sciget.org` (`dermatology`), all assets-only Cloudflare Workers but the first, and the `webapps.sciget.org` hub, which lists the catalogues and hosts no apps. Read [catalogue sites](docs/architecture/catalogue-sites.md) before changing hosting, the landing page or the build.

- Every app names exactly one home `catalog:` in `registry/apps.yml`, and may list other catalogues that serve a copy under `also_in:`; `site.catalogs` and `site.hub` hold the hosts and brands. A new app joins the primary catalogue unless `pnpm new-app --catalog <id>` says otherwise.
- `dist/` stays the all-app assembly. Each catalogue's desktop suite (`desktop:` in `site.catalogs`) is projected from it like the sites; read the catalogue sites document before changing the suites. `scripts/build-site.mjs` projects `dist-sites/<catalog>` and `dist-sites/hub` from it; `test/catalog-sites.test.mjs` (after a build) holds each site to its apps and to every file they reference.
- A handoff only works within one host, so each site's DICOM View lists only that host's apps. A moved or renamed app keeps its old links through the 404 table generated from the registry (`former_paths`, other catalogues' apps); do not hand-edit `site/404.html` routes.
- Reference shared runtime files (`_runtime/`) by plain string paths. The projection follows them and fails the build on a computed path.

## Working examples

Every new app must offer a scientifically suitable example in its input section so users can try the main workflow without supplying files. Follow the example contract in [the interface standard](docs/architecture/interface-standard.md#examples): declare pinned data, register offline assets, and test selecting an example through processing and download. Include loading, failure, retry and cancellation behavior. Keep the generated example control and browser coverage when replacing template placeholders.

## Browser agents (WebMCP)

Every app's WebMCP tools come from its `automation.json` (`packages/components/src/webmcp/tools.js`); an app writes no tool code, and `automation/` must stay free of imports from `webmcp/`, `ui/` or `elements/` (`test/webmcp-shell.test.mjs`). Any shell-loaded module goes into `SHELL_COMPONENTS` with everything it imports. Keep the page drop, shared file controllers and app list handlers (`nd-files`) free of WebMCP changes. When an example file's `role` differs from the contract's input role, map it in the example's `automation` field (`node scripts/webmcp-examples.mjs`, `test/webmcp-examples.test.mjs`).

Before modifying WebMCP prompts, examination isolation, turn binding (`examinedCall`), `viewers_niivue` allowlists, url `sourceRoots`, or the smoke suites (`webmcp.smoke.mjs`, `webmcp-examination.smoke.mjs`, `webmcp-interaction.smoke.mjs`), read the complete contract in [packages/components/src/webmcp/AGENTS.md](packages/components/src/webmcp/AGENTS.md).

## Reference app and minimal implementations

New apps are built to look familiar and read familiar. Start with the generator, not an empty page or a copied app:

- Run `pnpm new-app <id>`. The canonical `templates/app-template` wires `#controls`, `#viewer`, `#status`, About/Cite/Privacy, the shared imaging workspace, the technical console, and the shell smoke test.
- Keep `neurodeskViteConfig` in `vite.config.*` and `theme-app-dist.mjs` in the build script. Together they make `pnpm --filter <app> dev`, standalone preview, and the deployed site use the same shell and theme.
- Use `apps/dwi2trx` only as the richer workflow reference. Visual workflow grouping follows the template, per the interface standard.
- Do not draw your own bar, theme toggle, dialogs, download helper, NIfTI header parser or DICOM import. They exist in `@neurodesk/webapp-components` and `@neurodesk/runtime-support`; an app-local copy is a defect, not a convenience.
- An app is code the reference does not already provide: its scientific pipeline, its controls, its About/Cite text. Aim for the reference app's size or smaller. When a new app needs something general, add it to the shared package and use it from there.
- If `dev` and `build` look different, fix the shared shell path before touching app styles.

## Test browser apps through the public reverse proxy

When a user needs an interactive remote preview, use this host's existing HTTPS Caddy site. Prefer a narrow app path over T3 port forwarding or a temporary public tunnel.

1. Build the app's production bundle. For Zarro, run `pnpm --filter zarro build`.
2. Serve the build on loopback. For Zarro, run Vite preview on `127.0.0.1:5173` as the named transient systemd unit `zarro-preview-prototype.service`.
3. Route only `/zarro/*` to `127.0.0.1:5173` in `/etc/caddy/Caddyfile`. Keep the catch-all route pointed at T3 on `127.0.0.1:3773`.
4. Back up the active Caddy file before an edit. Run `sudo caddy validate --config /etc/caddy/Caddyfile` before `sudo systemctl reload caddy`.
5. Verify the public HTTPS app URL, a built asset URL, and the target workflow in the shared browser.

Keep preview servers bound to loopback. Use a different path and port for another app so its preview cannot replace the T3 route or another active preview.

## Data-gated browser tests

An e2e test that skips without data (`test.skip(!process.env.X, …)`) must run in CI. Add a provisioner to `scripts/lib/e2e-test-data.mjs` that downloads pinned, checksummed data and sets `X`, or list `X` under `unpublished` with the reason no public data exists; `test/e2e-test-data.test.mjs` fails otherwise. `browser-e2e` provisions on Linux; apps with `ci.hardware_gpu` run their whole suite on the free `macos-15` runner (`browser-e2e-gpu`, full Chromium on Metal, `NEURODESK_HARDWARE_GPU=1`). A hardware-GPU app can also declare a `cpu` subset: the variables whose tests run without a GPU; `browser-e2e` provisions it with `--cpu` on Linux so those tests run on every PR too. Locally: `node scripts/e2e-test-data.mjs <app>` (add `--cpu` for the subset) prints the variables to export.

## Offline package tests

`pnpm test:packages` runs in the `workspace-contracts` job of `ci`, so a package's `test` script must not reach the network. A test that needs downloaded data or a downloaded runtime goes in its own script (`test:reference` in brain-extraction, `test:runtime` in seedseg) that its app's `test` script runs, so the per-app job still runs it whenever the app is selected; the pure part stays in `test`. Never turn a failed download into a skip. Check a package offline with `unshare -rn sh -c 'ip link set lo up && pnpm --filter <package> test'`.

## CI scope

Keep iterative PRs in draft. Create them with `gh pr create --draft`. Before resuming edits on a ready PR, including review or CI fixes, run `gh pr ready <number> --undo` and confirm `gh pr view <number> --json isDraft --jq .isDraft` returns `true` before pushing. Batch related fixes and validate locally while the PR is draft. A draft runs unit and build tests but no browser job; for its browser tests run `gh workflow run ci.yml --ref <branch> -f scope=affected` (the ready plan of what the branch changed; its result shows in Actions and on the commit, not in the PR's checks, and does not count against the full-plan budget). Once local validation passes and review fixes are complete, push the final changes, then run `gh pr ready <number>` for integration testing. Before merging, wait for the full affected checks on that exact head. Draft results cover only development feedback.

- **Budgets and workflow registration:** Ready PRs are capped at 2 full-plan runs per 24 h (10 whole-catalogue runs/day across the repo, enforced by `ci-usage.yml` and `app-plan.mjs`; add `full-ci` label and re-run only when explicitly needed). Every non-reusable workflow job must declare `timeout-minutes` (`test/ci-policy.test.mjs`), every new or renamed workflow/job must be registered in `WORKFLOWS` in `scripts/lib/ci-measures.mjs` (`test/ci-measures.test.mjs`), and no workflow may listen to `workflow_run` (`test/workflow-reports.test.mjs`).
- **Shared-path gates:** Workflows building on shared trees list them in their `pr-gate.yml` `shared_paths`, never in PR `paths`, and regenerate `native.yml` with `node scripts/native-workflow.mjs` (`test/workflow-gate.test.mjs`).
- **Browser test tiers:** PRs and pushes to `main` skip `@slow` tests and skip `@heavy` CPU tests for apps reached only via shared code; nightly, manual and release runs include them (`test/e2e-tier.test.mjs`).
- **Full planner, gate, site-check and sharding specification:** Read [CI development tiers](docs/quality/ci-development-tiers.md) and [CI selection rules](docs/quality/ci-selection-rules.md) before changing `.github/workflows/`, `scripts/lib/app-plan.mjs`, `scripts/lib/workflow-gate.mjs`, or `registry/` keys.

## Upstream apps (qsmbly, seedseg, dicompare)

- These apps are copies of Ashley Stewart's repositories, which stay the source. `source:` in `registry/apps.yml` pins the upstream commit each copy last merged; `apps/<id>/upstream.json` lists upstream paths not imported, path and identifier rewrites, and the adaptations to keep.
- `.github/workflows/upstream-sync.yml` runs `scripts/sync-upstream.mjs` weekly and opens one PR per app on `upstream/<id>`: a three-way merge from the pinned commit, monorepo date versions kept, conflict markers left in a draft PR. Resolve conflicts on that branch; once a person has pushed to it the workflow stops overwriting it until it is merged or deleted. It pushes with the `neurodesk-webapps-upstream-sync` GitHub App so CI runs on its PRs ([setup](docs/architecture/upstream-sync.md)).
- Upstream files the monorepo deleted (replaced by shared code) stay deleted; their upstream changes are listed in the PR, not applied. Port anything relevant to the shared code by hand.
- The standalone bundle serves the dicompare worker, controller and the QSM/SeedSeg schemas from `apps/dicompare/public`, not from dicompare.neurodesk.org (`path` entries in `registry/offline-assets.sources.json`).
