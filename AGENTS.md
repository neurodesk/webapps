# Repository instructions

This repository stores source code only. Large validation datasets and models belong on [https://huggingface.co/datasets/neurodeskorg/webapps](https://huggingface.co/datasets/neurodeskorg/webapps). Every app is versioned `MAJOR.MINOR.YYYYMMDD`: the patch is the UTC release date (e.g. `0.1.20260808`). Describe changes in a changeset (`pnpm changeset`), then run `pnpm release`, which sets the date versions, writes changelogs and synchronises embedded version strings (`scripts/lib/app-versions.mjs`); `test/app-versions.test.mjs` rejects any other scheme. Keep scratch files off `/tmp`: `TMPDIR` points at the storage volume and turbo passes it through.

Every remote URL the apps or the offline bundle fetch (`registry/offline-assets.sources.json` and its lock, `models/*.manifest.json`, `apps/*/examples.json`) must be immutable: a Hugging Face commit, an exact npm version, a release asset or a commit URL. Mirror anything else to the dataset and pin it; `test/offline-asset-pins.test.mjs` rejects the rest.

pnpm's `minimumReleaseAge` blocks a dependency version for 24 h after it is published. To adopt a fresh release (e.g. a new `@niivue/niimath`) sooner, add that exact version to `minimumReleaseAgeExclude` in `pnpm-workspace.yaml`.

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
- Before completing UI work, run `pnpm audit:interfaces`, `pnpm test:mobile` and `pnpm test:interface-workflows` against a fresh production build. Review desktop and phone screenshots and exercise the changed workflow. The interface standard defines the review criteria and the audit's limits.

For catalog-wide work, use [the interface audit](docs/architecture/interface-audit.md) to track remaining changes per app. Update its findings when resolving them.

## Working examples

Every new app must offer a scientifically suitable example in its input section so users can try the main workflow without supplying files. Follow the example contract in [the interface standard](docs/architecture/interface-standard.md#examples): declare pinned data, register offline assets, and test selecting an example through processing and download. Include loading, failure, retry and cancellation behavior. Keep the generated example control and browser coverage when replacing template placeholders.

## Reference app and minimal implementations

New apps are built to look familiar and read familiar. Start with the generator,
not an empty page or a copied app:

- Run `pnpm new-app <id>`. The canonical `templates/app-template` wires
  `#controls`, `#viewer`, `#status`, About/Cite/Privacy, the shared imaging
  workspace, the technical console, and the shell smoke test.
- Keep `neurodeskViteConfig` in `vite.config.*` and `theme-app-dist.mjs` in the
  build script. Together they make `pnpm --filter <app> dev`, standalone preview,
  and the deployed site use the same shell and theme.
- Use `apps/dwi2trx` only as the richer workflow reference. Visual workflow
  grouping follows the template, per the interface standard.
- Do not draw your own bar, theme toggle, dialogs, download helper, NIfTI header
  parser or DICOM import. They exist in `@neurodesk/webapp-components` and
  `@neurodesk/runtime-support`; an app-local copy is a defect, not a convenience.
- An app is code the reference does not already provide: its scientific
  pipeline, its controls, its About/Cite text. Aim for the reference app's size
  or smaller. When a new app needs something general, add it to the shared
  package and use it from there.
- If `dev` and `build` look different, fix the shared shell path before touching
  app styles.

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

## CI scope

`scripts/lib/app-plan.mjs` picks the apps a change tests from the workspace graph (`scripts/lib/workspace-graph.mjs`): the packages, `exes/` directories and root files (`scripts/`, `test-utils/`, `registry/`, `test/`) each app reaches through a workspace dependency, a relative path, a repository-root path or an import. A change selects the apps that reach it; a path named only in a whole-line `//` comment of a root file (not a `///` directive) is not a reference. A root file that ci.yml's per-app jobs run (`app-tests`, `browser-e2e`, `browser-e2e-gpu`) selects every app; one only `composite-site` or its dependent `agent-interactions` job runs selects no app but still runs the site build. A package's `test/` reaches only the apps that read from it. Markdown outside `apps/` that no runtime reads, root `package.json` scripts ci.yml never calls, lint tooling and other workflows select nothing; an offline asset lock change selects the apps whose assets changed. A `pnpm-lock.yaml` change selects the apps that reach an importer whose entries or resolved dependency closure changed, before or after (`scripts/lib/lockfile-impact.mjs`); a change to the root importer, to a section other than importers, packages and snapshots, or one the planner cannot resolve selects every app. A `registry/apps.yml` change selects the apps whose entries changed and the site build; any other section selects every app. A `registry/standalone.json` change whose head catalog passes `validateStandalone` selects the apps whose entries changed and the site build (a suite-only change selects only the site build); an invalid catalog or a change to any other field selects every app. A root `.gitattributes` change counts as a change to every file whose attributes git resolves differently at the merge base and at head (`git check-attr --source`); if that comparison fails, it selects every app. `runtime-assets/manifest.json` selects the apps that reach `scripts/fetch-app-runtime.mjs` and the site build; an app's `automation.json` also selects the apps that reach `scripts/lib/neuroflow-bundle.mjs`, which generates NeuroFlow tools from every contract; the landing page, `site/analytics.json`, `site/404.html` and `site/dicompare-routes.js` select only the site build. `test/app-plan.test.mjs` fails when another file reads either. Without the base text of either file the planner selects every app. The plan job lists why it selected each app, or why it fell back, in its summary and `selection_reasons` output. Root configuration (`package.json` dependencies except root-only Knip, Stryker and ESLint devDependencies, `pnpm-workspace.yaml`, `ci.yml`) still selects every app. Knip and Stryker run in independent quality workflows and ESLint (`eslint`, `@eslint/js`, `globals`) only in workspace-contracts and code-quality; their root-only closure is omitted only after validating all resolutions, and other importers keep their full closures. When a pull request selects the whole catalog, the macOS GPU suite runs after merge and nightly instead; dispatch `ci` on the branch to run it first. Portable Node package workflows build on linux-x64 for pull requests and on every target after merge, on manual runs and on releases. `node-cli.yml` builds one package on every target when the shared packager changes. A native or CLI workflow that filters on a whole package also lists every file that package's command line imports from other workspace packages (`scripts/lib/module-closure.mjs` follows its bin and Node entry points); `test/independent-workflows.test.mjs` fails on a gap. `test/app-plan.test.mjs` and `test/independent-workflows.test.mjs` hold these rules. Before narrowing selection further, replay the planner over merged PRs with `scripts/app-plan-shadow.mjs` (it reports misses against an independent oracle) and measure with `scripts/ci-minutes-report.mjs`; [the October 2026 report](docs/quality/ci-selection-shadow-2026-10.md) holds the last results. The nightly run has its own concurrency group so a push to main cannot cancel it. A push to main still cancels the previous push run, so a push diffs from the head of the last successful `ci` run on main (push, nightly or dispatch; `scripts/lib/tested-base.mjs`), not from its own `before`: it tests every merge since main last went green, including merges whose runs were cancelled or failed. Without such a run among the newest 100, or when its head is not an ancestor, the push selects every app.

Pull requests and pushes to main skip Playwright tests tagged `@slow`; nightly and manual runs include them. Release browser tests also select the full suite, subject to their data requirements. Tag a test `@slow` (`{ tag: '@slow' }`) only when an untagged test completes a run with the same model, method, option and kind of geometry. A browser reference case that is the only completed run of a path stays untagged. An app with tagged tests spreads `e2eTier` from `test-utils/e2e-tier.mjs` into its Playwright config (the shared config builders already do); `test/e2e-tier.test.mjs` checks it. The browser jobs in `.github/workflows/ci.yml` log per-test durations for tagging decisions.

An app can set `ci.e2e_shards` to 2-4 in `registry/apps.yml`. The CPU browser job splits its selected tests by spec file unless the Playwright config is `fullyParallel`; unit/build and hardware GPU jobs stay unsharded. CI builds each app before its browser tests and sets `NEURODESK_E2E_PREBUILT=1`, so the example smoke driver uses that production bundle. Its standalone invocation retains the normal build. Rust jobs restore Cargo build directories using lockfile-based cache keys, including the shared Greedy workspace.

## dwi2trx

- WebGPU-only app (diffusion tensor fitting + GPU streamline tractography); it throws a clear error at startup on a browser without WebGPU, and streamline tracking additionally requires `subgroups` support.
- `packages/dwi2trx` and `apps/dwi2trx` pin `@niivue/niimath` to the vendored `file:./vendor/niimath` build (dtifit-enabled, niimath `cc26582`), which NODDI also uses. The registry `@niivue/niimath@1.4.20261016` has dtifit but not the repeated-eigenvalue fix (rordenlab/niimath#83): on a prolate tensor its V1 is not unit length, and the NODDI dtifit tests fail. Move to the registry package only when a release's source contains niimath `cc26582` (the #83 fix) and `3ff6e9af` (the `./package.json` export, rordenlab/niimath#82). Both are required: `@neurodesk/dwi2trx/niimath-version` imports `@niivue/niimath/package.json`, which DWI2TRX and NODDI write to provenance, and the vendored `package.json` has the same export. On the example, 1.4.20261016 gave the same FA, L1-L3 and tensor bytes, MD within 1 float32 ULP and V1-V3 within 0.025°, so that move re-records the browser reference (#495).
- `public/brainchop/` is generated by `scripts/copy-brainchop.mjs` (stages `@brainchop/mindgrab`'s WebGPU assets for runtime fetch) and is gitignored — regenerate it via `dev`/`build`, don't hand-edit or commit it.
- TypeScript unit tests under `src/` run with `node --experimental-strip-types`, not a bundler.
- The Playwright e2e smoke test needs a WebGPU-capable Chromium.

## brain2print

- WebGPU is optional: the NiiVue viewer falls back to WebGL2, and MindGrab's `auto` backend prefers hardware WebGPU, hardware WebGL2, then threaded CPU. Report a startup error if the viewer cannot initialize either graphics backend.
- `public/brainchop/<mindgrab-version>/` is generated by `scripts/copy-brainchop.mjs` (stages `@brainchop/mindgrab`'s `16chan18cls`, `mindmap` and `mindsnap` models, WebGPU, WebGL2 and threaded-CPU builds of each, for runtime fetch) and is gitignored — regenerate it via `dev`/`build`, don't hand-edit or commit it. The directory is versioned so a cached old `worker.js` can never be served against a newer page.
- The default segmentation is mindmap's partial-volume estimate (`segmentTissues`), not a label model: GM + WM fraction summed into one Float32 NIfTI, meshed at isovalue 0.5: a sub-voxel surface, smoother than a label boundary.
- The NiiVue rc.11 controller has no single-volume removal (`removeVolume` lives on its internal model); `dropOverlays()` reloads just the base image with `nv.loadVolumes([nv.volumes[0]])`.
- The pipeline (segmentation, the GM + WM sum, niimath `-mesh`, the manifold and winding check, STL/MZ3) lives in `packages/brain2print`, shared by the app and the `brain2print` command line; change outputs there. The app injects its browser runtimes (`src/browser.js`), the command line the CPU MindGrab and niimath drivers from `@neurodesk/node-drivers`. Its release check holds every file byte for byte to `validation/browser-reference.json`, recorded by `validation/browser-reference.mjs` from the pipeline in Chromium with MindGrab's CPU backend; rerecord it when MindGrab, niimath or the pipeline changes. MindGrab stays at the version the Node driver mirrors.
- The e2e pipeline tests run segmentation with `backend: 'cpu'` in Chromium's software adapter; the CPU automation test's downloads must equal the `mni152-pve` pins in `browser-reference.json`. The hardware variants need `NEURODESK_HARDWARE_GPU=1` on a Mac. Mesh outputs (`*.stl`, `*.obj`, `*.mz3`) are gitignored; reference data goes to Hugging Face.

## fastprep

- The Rust core (`exes/fastprep/core`) decides every step and emits tool argv, as written to `work/commands.sh`. The native CLI (`exes/fastprep/cli`) runs it as processes; the browser host (`packages/fastprep/src/drivers.js`) maps it to WASM/WebGPU runtimes and rejects options it does not declare. A core change that adds a tool option needs a driver change, or the browser run fails.
- Byte parity with the Python reference (`fastprep.py`, `glm.py`) is the goal. Deliberate divergences are listed in `exes/fastprep/README.md` and `exes/glm/README.md`; add any new one there.
- niimath WASM reads `ENV` during startup, so set it in Emscripten `preRun`. It has no zstd: `.nii.zst` names are staged as raw `.nii`.
- `vite.config.js` excludes `@brainchop/mindgrab` and `onnxruntime-web` from `optimizeDeps`: MindGrab's top-level await breaks esbuild's es2020 dev pre-bundle, and `dev` fails without it. Any app importing either needs the same.
- The full-example e2e test is `@slow` and needs `NEURODESK_HARDWARE_GPU=1`; the headless shell has no WebGPU and takes hours.
- ME-ICA runs after the apply stage for runs with ≥3 magnitude echoes (`--meica auto|on|off`, default `auto`): the core emits `meica` and `meica --denoise` argv, writing `space-*_desc-denoised_bold` beside each preproc. The Rust core must match `fastprep.py`'s commands and ME-ICA outputs.
- `meica` is `@niivue/meica`, pinned exactly in `packages/fastprep` and `apps/fastprep` (single-threaded WASM, staged into `public/meica` by `scripts/copy-runtime.mjs`, driven by `meicaDriver`); the native CLI runs the meica-rs binary from `<home>/bin`.
- When head motion is locked to the task, tedana's default tree can reject task signal (motor3T: task>baseline |t|>5 voxels 4565 → 86). The report warns; denoised is a separate output, never a replacement. Full results: `~/src/fastprep/plan_meica.md`.
- The multi-echo example `motor3t-me` (HF `fastprep/example-me`, staged by `stage_me_example.py` in fastprep.py's repository) has its own `@slow` hardware-GPU e2e test.

## ants

- Greedy's interface driving the ANTs SyN WebAssembly kernel from `packages/registration` (the same kernel and ANTsPy `SyN` schedule as SYNcro); the worker inflates gzipped NIfTI before writing `.nii` because ANTs reads by file name.
- `public/registration/` and `public/brainchop/` are generated by `scripts/copy-runtime.mjs` before `dev`/`build` and are gitignored. Registration does not auto-run on load: SyN on the 1 mm examples takes about a minute on an M4 Pro.

## elastix

- Registration is `@itk-wasm/elastix` (pinned exactly), reading with `@itk-wasm/image-io`, writing the HDF5 transform with `@itk-wasm/transform-io`, OME-Zarr through `@fideus-labs/ngff-zarr` and TIFF through `@fideus-labs/fiff`. It needs no WebGPU: elastix is single-threaded CPU WebAssembly and the viewers use NiiVue's WebGL2 backend, so hosted CI runs its whole workflow.
- `public/pipelines/` is generated by `scripts/copy-pipelines.mjs` before `dev`/`build` and is gitignored. `src/pipelines.js` must be the first import: a pipeline call before it fetches from jsDelivr, which the offline desktop refuses and the e2e suite fails on. image-io is staged whole because `readImage` walks every format for an unknown extension; add an elastix or transform-io pipeline to the script before calling it.
- fiff's peer range pins one ngff-zarr minor (`fiff 0.8.2` needs `ngff-zarr ^0.38.0`); bump them together. Keep fiff at 0.8.2 or later: earlier releases fail on SubIFD pyramids with geotiff 3, which `e2e/formats.spec.js` checks.
- The presets, the float32 cast (`registrationImage`), the parameter-file chain, source classification and the transform estimate live in `packages/elastix`, shared by the app and the `elastix-register` command line (`bin/elastix-register.js`, `src/node.js`); change them there. The app keeps the UI, the worker runner and the browser IO adapters (`src/io.js`).
- Both images are cast to float32 before elastix (its pipeline dispatches on the stationary image's pixel type and casts the result back to it, which wraps B-spline overshoot in integer types). ITK-Wasm IO runs on one shared worker, one call at a time: concurrent `readImage` calls deadlock. A zero-length transform parameter field comes back as its `data:application/vnd.itk.address` placeholder; `withTypedParameterArrays` replaces it before `writeTransform`. transform-io 1.1.0 cannot write a BSpline transform to HDF5 (it crashed the tab), so `hdf5Writable` drops that download for B-spline runs.
- The written TransformParameters files are TOML (`writeParameterFiles` picks the format from the `.toml` names), chain through `InitialTransformParameterFileName`, and the transform maps stationary to moving points. `packages/elastix/validation/parameter-matrix.mjs` composes the files into a matrix; `e2e/automation.spec.js` and the command line's `cli-check.mjs` check it against a known displacement; keep that composition in step with any change to the presets.
- The OME-Zarr transform (`estimateTransform` in `packages/elastix/src/transform-export.js`, `writeTransformOmeZarrFile` in the app) is evaluated by elastix's own transformix on coordinate images, so it follows every transform elastix can write. Linear stacks become one RFC-5 `affine` fitted from the stationary corners; anything else becomes a `displacements` field on the stationary grid, staged in a MemoryStore and zipped with `storeToZip`. Frames come from one-voxel proxies of the two images. Keep `transformix` in `scripts/copy-pipelines.mjs`. `e2e/ome-zarr-transform.mjs` checks both forms by resampling through the archive.
- Node cannot run ngff-zarr's array readers or writers (they start Web Workers from blob: URLs), so `e2e/fixtures.mjs` writes its OME-Zarr 0.5 store by hand and gives fiff the plane through `getPlane`, and the command line (`packages/elastix/src/node-ngff.js`) reads and writes array data with zarrita on the main thread and writes the displacements store's metadata itself. `validation/cli-check.mjs` holds every command-line output to the web app's, recorded by `e2e/reference.spec.js` (`ELASTIX_BROWSER_REFERENCE=write`) in `validation/t1-mni-reference.json`; rerecord it when elastix, ngff-zarr or a preset changes.

## FreeBrowse viewer (topofit, spinalcordtoolbox, dicomview)

- `packages/runtime-support` pins `freebrowse` to the vendored `file:./vendor/freebrowse` build of FreeBrowse's development branch, which is not on npm. Rebuild it only with `node packages/runtime-support/scripts/vendor-freebrowse.mjs` (the vendor README names the commit). Return to a registry pin once upstream publishes that code.
- The branch builds against an unreleased niivue-mono checkout; the vendored build was made against `@niivue/niivue` `1.0.0-rc.17`, the first release with the drawing undo snapshot its wand calls, and runs on the `1.0.0-rc.26` that `packages/runtime-support` pins (rc.25 fixed `loadDrawing` on permuted images, which SCT's mask editing needs). Every app that mounts the viewer pins that same NiiVue. FreeBrowse's eye button sets a volume's `visible` flag (niivue/mono#224), which NiiVue draws from rc.24. A volume is shown only when `visible` is not false and its opacity is above 0: code that reacts to `volumeUpdated` checks both, and code that shows a volume itself also sets `visible: true` (SCT's `SctViewer`, TopoFit's 3D anatomy clip).

## topofit

- `apps/topofit/src/stl-worker.js` imports `@niivue/niimath/niimath.js` (the package's raw Emscripten
  export) and calls `callMain` directly instead of the fluent `Niimath`/`.mesh()` API: that API's `run()`
  always appends `-odt <type>` as the final argv, but niimath mesh mode reads the *last* argv as the
  output filename, so the fluent API cannot select mz3 output. The pinned `@niivue/niimath@1.4.20260909`
  WASM build is also compiled without `HAVE_FORMATS`, so it can only write `.mz3`; `@neurodesk/webapp-components/file-io/mesh`
  round-trips mz3 and writes STL itself. Both are fixed upstream in `~/src/niimath` for the release after
  1.4.20260909 — once that ships, drop the direct `callMain` path and `writeMz3`/`readMz3` for the fluent
  API's own STL output.
- The `topofit` command (`packages/topofit/bin/topofit.js`, `src/node.js`) runs the same pipeline on the CPU
  with `onnxruntime-node`; `exes/node-cli` packages it (shared with SYNcro, driven by `release.json`), and
  every archive must pass `validation/cli-check.mjs`. Only presets in the pipeline's `MODELS` are accepted or
  installed; add `synth-1mm` there only together with its own parity report.

## white-matter-lesions

- The pipeline, output writer and model pins live in `packages/white-matter-lesions`, shared by the
  worker and the `flames` command (`bin/flames.js`, `src/node.js`); change outputs there so both stay
  identical. Its `model.manifest.json` must equal `models/white-matter-lesions.manifest.json` (tested).
  Every `flames` archive must pass `validation/cli-check.mjs`: mask Dice >= 0.998 against the worker path
  on ONNX Runtime Web (`validation/web-reference.mjs`).

## bison

- The pipeline (denoise, N4, `volume_pol`, registration to ICBM 2009c, features, random forest, outputs) lives in `packages/bison`, shared by the app's worker (`src/browser.js` drivers) and the Node code (`src/node.js`, `src/node-workers.js`). It is pure: the tools are injected (header of `src/preprocess.js`). Change outputs there so both stay identical.
- The classifiers, tissue priors, histograms and `Av_FLAIR` are published under `bison/models/` with the permission of Mahsa Dadar (2026-10-24, `models_permission` in `models/bison.manifest.json`). They are at a later dataset revision than the templates, so each has its own pinned `url`. Node tests and `bin/bison.js` can read a local copy from `BISON_ASSET_DIR` (`--asset-dir`).
- The reference is the upstream BISON and BISON-WMH scripts on MINC preprocessing, run on epic with the MINC toolkit (`packages/bison/validation/native`, its `README.md`). Its "Divergences from upstream" section and `docs/preprocessing.md` map every step; add any new divergence there.
- Every registration runs on Greedy: the T1 affine and FLAIR rigid with NMI, the T1_VP warp with NCC (`GREEDY_NONLINEAR`: radius 2, unmasked, to 1 mm). Masking it or stopping at 2 mm failed sub-HML0774's CSF gate (`docs/preprocessing.md#nonlinear-step`); rerun all ten gates before changing it. hmc `--apply` still resamples, through the warp and then the inverse affine. Both the browser and Node run Greedy's committed single-threaded WebAssembly (`@neurodesk/greedy/single`, its `src/worker.js` in the browser); the native `greedy-rs` gives different matrix digits, so it would break the byte equality.
- N4 replaces `nu_correct` with its own four-level schedule (`N4_OPTIONS`), not a one-to-one option translation: the direct translation stops early and brightens deep grey matter ([preprocessing.md#n4](packages/bison/docs/preprocessing.md#n4)). Keep it unless a new comparison against N3 on every validation subject shows better.
- Each registration group and each denoised image gets a new WebAssembly instance, in its own Worker in the browser and worker thread in Node, so its memory is freed when it ends. Do not reuse an instance across stages.
- Outputs are on the native T1 grid: uint8 labels, one float32 probability per class and the uint8 mask, gzip level 9 with mtime 0 (`src/outputs.js`), so the bytes are the same in every browser and on the command line.
- `apps/bison/scripts/copy-runtime.mjs` stages the hmc-registration and ants-denoise workers and kernels (pthread builds, so the page needs cross-origin isolation) and Greedy's worker and single-threaded build in the gitignored `public/bison-runtime/`. ONNX Runtime Web starts its threads from `src/worker.js` (named `em-pthread`); the worker must not set its own message handler there.
- The `bison` command line ships through `exes/node-cli` (`packages/bison/release.json`, `bison-native.yml`). Its archives bundle the model files and must pass `validation/cli-check.mjs` against `validation/browser-reference.json`, which `bison-native.yml` also checks the built web app against; rerecord it when the pipeline, its tools or the models change.

## ants-denoise

- The app runs `@neurodesk/ants-denoise`'s own module worker (`?worker&url`; Vite emits the kernel beside it), one worker per run, terminated on cancel. Change the filter in the package, so the app and BISON stay identical.
- `e2e/expected.json` pins native ANTs 2.6.5 `DenoiseImage` on the example with one ITK thread (`scripts/native-reference.mjs`, Docker), and the browser tests must reproduce it byte for byte. Rerecord it after a module rebuild or an example change.
- The radii stop at the largest pair checked against native (patch 2, search 3), and the shrink factor stays 1. The app has no command line of its own: the Standalone dialog lists the ANTs container (`registry/standalone-exceptions.json`).

## brainqcnet

- The preprocessing, slice classification loop, summaries and CSV writers live in `packages/brainqcnet`; the app adds the UI, the ONNX Runtime Web worker (one per run, terminated on cancel) and the file names. Change numerics in the package only.
- `e2e/workflow.spec.js` runs each example on WebAssembly and requires every table to equal the original container's (`packages/brainqcnet/validation/references`) byte for byte, except tot_df.csv's `t`, the processing time. The still example is the untagged run (3.4 minutes on 8 cores, longer on hosted runners); the motion example is `@slow`.
- The app has no command line of its own: the Standalone dialog lists the authors' `garciaml/brainqcnetcpu` image at tag 1.0.1 (`registry/standalone-exceptions.json`); the validation pins its digest. The deployed-site check rejects a digest in the dialog.

## nesvor and the compute server

- `apps/nesvor` is the first app whose method runs outside the browser: NeSVoR needs CUDA, so the
  app sends jobs to a `neurodesk-compute` server the user runs in their own network
  ([ADR-0003](docs/adr/0003-remote-compute-nodes.md), [design](docs/architecture/nesvor-remote-compute.md),
  [protocol](docs/architecture/remote-compute-protocol.md)). The connection panel is the shared
  `nd-compute-connection` element and the client is `@neurodesk/webapp-components/compute`; do not
  write app-local fetch code for the protocol.
- `exes/compute-server` (Rust, binary `neurodesk-compute`) and `test-utils/compute-reference-server.mjs`
  (Node, simulated tool, used by browser and desktop tests) implement protocol v1. Change the protocol
  document first, then both implementations, then run `test/remote-compute-protocol.test.mjs` against
  both (`COMPUTE_SERVER_URL`/`COMPUTE_SERVER_TOKEN` select a running server). `apps/nesvor/src/spec.js`
  is shared by the app and the reference server; `exes/compute-server/src/tools/nesvor.rs` mirrors it.
- The container digest is pinned in the design document, `registry/neurocontainers.json`, the Rust tool
  definition and the reference server. Update all four together. The SCT tool's image is pinned in
  `apps/spinalcordtoolbox/web/js/app/analysis-spec.js`, `exes/compute-server/src/tools/sct.rs`,
  `registry/neurocontainers.json`, the protocol document and both READMEs;
  `apps/spinalcordtoolbox/test/native-analysis.test.js` fails when they disagree.
- An app whose processing is not in the browser overrides `execution` in `registry/app-information.yml`
  and states the data flow in its own Privacy template. The desktop suite reaches a compute server only
  through `NEURODESK_COMPUTE_ORIGINS`.
## nii2tvx and disconnectome

- `exes/nii2tvx` is the C tool (the first non-Rust entry in `exes/`); `apps/disconnectome`
  is its web front end. `nii2tvx.c` is split by `#ifndef __EMSCRIPTEN__`: above it the query
  core, buffer in and numbers out, no file I/O and no zlib, which is the whole 21 KB WASM
  surface; below it file reading, TRK/TCK conversion and `main`. Keep that boundary or the
  browser build grows a filesystem.
- The browser owns gzip (`DecompressionStream`); `mask_open` takes uncompressed NIfTI bytes.
- The TSV must match the CLI byte for byte, so JavaScript formats fractions with a `%g`
  reimplementation, not `toPrecision`: the two differ on `nan`/`NaN`, on `3.24086e-05` versus
  `0.0000324086`, and on `1e-07` versus `1e-7`. `make test` enforces it.
- Lesions must sit on the atlas grid (MNI152 1 mm, 182x218x182, sform). The app refuses
  anything else and points at SYNcro, which normalizes to exactly that template.
- The display TRX and the query TVX are different files on purpose: numbers come from the
  full-resolution atlas, geometry from a decimated copy. `apps/disconnectome` says so in
  About; keep that distinction if either file changes.
- Two atlases ship, ENIGMA Symmetric (65 bundles, the default) and HCP1065 (87). They are
  different parcellations, so a result cannot be carried across a switch and the saved TSV
  names the atlas. `models/disconnectome.manifest.json` holds the pairing under `atlases`.
- Build an ENIGMA-style TVX from a 1 mm source, never a 2 mm one: `nii2tvx` rasterizes each
  segment with Amanatides-Woo, so 2 mm chords cut corners into voxels the streamline never
  enters. Measured, that doubled a small deep lesion's score and made the file larger.
- `@neurodesk/nii2tvx` decodes tract names itself rather than calling `UTF8ToString`: past
  16 bytes Emscripten switches to `TextDecoder`, which the browser refuses on the resizable
  ArrayBuffer behind a growable WASM memory. HCP1065's short names never hit it; ENIGMA's do.
- Every remote asset is checksummed against the manifest, the display TRX included: it is
  fetched through `fetchModel` and handed to NiiVue as an object URL rather than by URL, so
  the mesh parser never sees unverified bytes. `fetchModel` also re-verifies on a cache hit.
- The TVX supplies the numbers and the TRX the colours, keyed by bundle name, and the two are
  built by different scripts from different source trees. `make test-real` diffs the two name
  sets; if they ever drift the app colours nothing while every number stays right.
- `_malloc` returns 0 rather than aborting in this build, so the wrapper checks it: an
  unchecked `HEAPU8.set` at address 0 corrupts the module instead of failing.
- NiiVue rc.13 is required, not the rc.11 most apps pin: `setTractOptions`'s
  `groupColors` (colour and visibility per TRX group, in one call) and `dps` arrived in rc.13.
  The 3D clip plane is load-bearing, not decoration: without it the opaque volume render hides
  every bundle inside the brain.
- The Standalone bar action belongs to the shell and renders `registry/standalone.json`; an app
  cannot replace it with its own dialog. Every registered app needs an entry there or the
  catalog check fails.
- The `disconnectome` command line is `packages/nii2tvx/bin/disconnectome.js`. It shares the
  row id, file name and grid refusal with the app through `@neurodesk/nii2tvx/disconnectome`, and
  ships a copy of `models/disconnectome.manifest.json` that its tests require to be identical;
  `repoint_manifest.sh` writes both. Its release check compares each example's table with the
  committed native goldens in `exes/nii2tvx/test`.
- Examples are declared once, in `apps/disconnectome/examples.json`, which the shared
  `nd-example-selector` downloads and checksums. Re-pinning the dataset changes every URL, so
  after `repoint_manifest.sh` run `apps/disconnectome/scripts/sync-examples.mjs` and then
  `scripts/lock-example-assets.mjs`, dropping the old revision's entries from the offline
  inventory first.

## carotid-flow

- Two methods, chosen by the phase data (`isSignedPhase`). Signed velocity goes through `detectFromVelocity` (flow in ml/min); an unsigned speed image goes through `detectFromVariability`, the port of the requesting lab's `standalone_automatic_carotid_flow.m`. Keep the port faithful: `test/carotid.test.js` pins the vessels it selects on the lab's export (right 12 px, left 4 px, `CAROTID_FLOW_EXAMPLE`, not public). State any deliberate departure in `README.md`.
- The example is PCMCalculator's MIT test data. Its right carotid must stay within 10 % of PCMCalculator's 225 ml/min (`CAROTID_FLOW_OPEN_EXAMPLE`), and the e2e and offline workflow tests pin 231 and 211 ml/min.
- Left and right are the patient's, from the affine. The MATLAB script called the image-left vessel left, which on the scanner's radiological grid is the patient's right; do not "fix" the app back to the script.
- Raw ±4096 phase needs the VENC from the user; velocity-scaled phase does not. Aliasing is not unwrapped.
- The detection, series reading and output naming live in `packages/carotid-flow`, which the app and the `carotid-flow` command line both import. Change the outputs there, not in the app, so the command line keeps writing the app's downloads byte for byte. `validation/pcmcalculator.json` holds the example's pins for both the open-example unit test and the command line's release check.

## mri2vid

- DICOM pixels come from dcm2niix (`@niivue/dcm2niix` JPEG build, pinned exactly; staged into `web/vendor/dcm2niix` for the app, `@neurodesk/node-drivers/dcm2niix` for the command line). The header parser in `readers/dicom.js` only groups series, so compressed files group too. `readDicomSeries` permutes dcm2niix's volume back to `MRI2vid.py`'s [rows, cols, slices] layout from the series' ImageOrientationPatient; the parity goldens (`tools/test/pipeline_parity.test.mjs`, also run on an RLE copy) hold it bit for bit. dcm2niix reads mosaic tags only from a SIEMENS file, so phantoms must say so. A series without ImageOrientationPatient keeps dcm2niix's stored layout (rows flipped back), not an assumed orientation. A mosaic run (the files tiled and acquired like the first by name: same TE, TR, TI and flip angle, so a second echo is left out) is converted only as far as the reduction needs: one file for `first`, 256 MB batches for `mean` and `max`, the mean's float64 sum carried across batches (`readNifti`'s `total`) so batching cannot change a pixel.
- The readers, series selection (`sources.js`), frame pipeline, video settings and muxers live in `packages/mri2vid`; the app keeps only its UI, canvas drawing and WebCodecs encoder (`web/js/encode.js`, `annotate.js`) and imports the rest from `web/vendor/mri2vid`, staged by `packages/mri2vid/scripts/stage-browser.mjs`. Change shared behaviour in the package so the `mri2vid` command line follows.
- The command line encodes VP9 with libvpx from `@libav.js/variant-vp9-opus` (pinned exactly) in real-time mode, converting RGB to full-range BT.709 I420 because that is what Chromium's VP9 encoder reports for canvas frames. It cannot write H.264: its MP4 is VP9 in MP4.
- `validation/browser-reference.mjs` records the production app's videos in Chromium; `--check` (in `mri2vid-native.yml`) fails when the app's output drifts. Re-record and commit after changing the pipeline, the video settings or the Playwright version. `validation/cli-check.mjs` documents its PSNR thresholds and the negative controls behind them.

## easy-mp2rage

- The WASM core in `packages/easy-mp2rage/wasm/` is committed. The web app stages it (`tools/stage_core.sh`) and the `easy-mp2rage` command line loads it, so both run one binary. After changing `crates/mp2rage-core` or `crates/mp2rage-wasm`, run `pnpm --filter @neurodesk/easy-mp2rage build:wasm` (Rust 1.98.0, wasm-pack 0.13.1, binaryen `version_117` wasm-opt) and commit the result. The `wasm-source` job in `easy-mp2rage-native.yml` rebuilds it from source and fails when the committed bytes differ; a toolchain bump means rebuilding and committing in the same change.
- `packages/easy-mp2rage/validation/cli-check.mjs` holds every command-line output, for each option, to the Python pipeline's files in `apps/easy-mp2rage/tools/golden/cli/` and to the web worker's WASM calls. After changing the Python pipeline or adding an option, rerun `tools/gen_cli_golden.py` and add a case whose output the option changes.

## lcmodel

- `exes/lcmodel` is a subprogram-by-subprogram port of LCModel 6.3-1N's Fortran; `PORTING.md` is its contract (REAL stays f32, REAL literals in DOUBLE expressions go through `r2d`, `X**2` is `x * x`, operation order kept). `tests/native_parity.rs` compares every number of `.TABLE` and `.COORD` with gfortran's output on LCModel's test case; they are identical. Keep them identical: a change that alters a number needs the native build (`gfortran -O2 -std=legacy -fno-f2c -fno-backslash -fall-intrinsics LCModel.f`) to show the Fortran does the same.
- `src/state.rs` is generated by `tools/gen_state.py` from `lcmodel.inc`; rerun it rather than editing. `MUNFIL` is lowered to 16384 for the browser heap.
- The PostScript report is not ported; control files need `lps=0`.
- `exes/fida` ports FID-A. Readers reproduce FID-A's quirks on purpose (conjugation and ppm-axis sign per reader); the GE pipeline conjugates and phases on the residual water as `run_pressproc_GEauto` does. `validation/README.md` lists the Octave references; regenerate them rather than loosening a tolerance.
- The FID-A references (and the example inputs they need) are pinned on Hugging Face under `lcmodel/fida-reference/` by `exes/fida/validation/reference.manifest.json`. `fetch_reference.py` downloads and sha256-checks them; the `fida-reference` job in `lcmodel-native.yml` runs `exes/fida` and `packages/lcmodel/wasm` tests on them with `FIDA_REQUIRE_REFERENCE=1`, which turns every missing-data skip into a failure. After regenerating references, repack with `pack_reference.py`, upload, and re-pin the revision. Export twix-derived references from the de-identified `lcmodel/examples/` copies, never from FID-A's originals.
- `packages/lcmodel/src/lcmodel.wasm` is committed: after changing either crate or `packages/lcmodel/wasm/src`, run `make -C packages/lcmodel wasm test`. Build it on Linux with Rust 1.98.1 and binaryen `version_117` wasm-opt (e.g. in the `rust:1.98.1` container with 8 GB of memory). LLVM folds math constants with the host's libm, so a macOS build moves FID-A's drift estimates by about 1e-7, and `web-app-reference` fails its byte-for-byte check against `validation/browser-reference.json`.
- MEGA-PRESS: FID-A's `run_megapressproc_auto` (validated by `exes/fida/tests/ref_mega.rs`), then LCModel `sptype='mega-press-3'` on the difference spectrum. Its basis set must come from the shaped-pulse simulation (`simulate_mega.m`, `sim_megapress_central.m`): instantaneous editing pulses leave NAA's 2.01 ppm singlet almost untouched, while real 14 ms pulses nearly erase it in edit-ON, and that negative NAA is LCModel's MEGA-PRESS reference. FID-A's shaped simulation centres at 3.0 ppm; the library centres at 4.65 ppm.
- Basis sets are FID-A simulations (`exes/lcmodel/basis/`), published gzipped (`gzip -9n`) on Hugging Face and pinned in `models/lcmodel.manifest.json`. A new set is a `library.json` entry, `simulate_library.m` (or `simulate_mega.m`) + `make_basis.py <sim> <out> <id>`, an upload, and a manifest update; existing sets must rebuild byte for byte. `packages/lcmodel/src/basis-select.js` ranks them by field strength (LCModel warns at 5 %, stops at 20 %), sequence family and TE, then prefers a shaped-pulse set (`-shaped`, `sim_shaped.m`, `"pulses": "shaped"` in the manifest) over the ideal one with the same parameters, and ranks MM-suppressed MEGA sets below standard ones. Keep the ideal sets: published fits depend on them.
- Co-edited macromolecules: for a MEGA-PRESS set with `"coEditedMM": true` the app's control file adds CHSIMU MM09 (0.915 ppm) and MM3co (3.0 ppm, 14 Hz, 2 protons) tied by CHRATO `MM3co/MM09 = 1 +- .2` and CHCOMB `GABA+MM3co`, fitting to 0.5 ppm with PPMGAP 1.2-1.95 ppm left out, as Osprey's MEGA LCModel jobs do (`GAP.diff1`; Zöllner et al. 2022, MM09soft). GABA+ is stable across priors and the gap (0.28-0.31 of NAA+NAAG on both examples); the GABA/MM3co split moves with them, so About says so. `packages/lcmodel/wasm/src/session.rs` (`mega_tests`) pins the numbers and duplicates the control lines; change both together. It is the default; the LCModel settings option (automation `macromoleculeModel`: `co-edited` or `none`) keeps the previous mega-press-3 analysis (4.2-1.95 ppm, GABA = GABA+ 0.153/0.241 on the examples, also pinned). MM-suppressed sets (`"mmSuppressed": true`, edit-OFF 1.5 ppm) always use `none`. Results lead with GABA+ and flag GABA and MM3co as model-dependent; keep both visible.
- Unedited fits use a widened line-broadening prior, `desdt2=2 rfwbas=80` (`LINE_BROADENING` in `packages/lcmodel/src/lcmodel-io.js`), because the library's 1.5 Hz Lorentzian basis sets make LCModel's defaults scale 13 % low on synthetic truth and 8-15 % below spant's ABfit on the same files (PR #120; `packages/lcmodel/test/water-scaling.test.js` checks it in the `lcmodel-native` CI job). It applies with or without water so ratios and concentrations share one fit. MEGA-PRESS keeps LCModel's values: the widened prior moved GABA+/NAA by 16-31 % there with nothing to validate it. "LCModel defaults" stays an option; the test case's native table is checked under it, and `tests/native_parity.rs` never uses the app's defaults.
- GE and Philips MEGA-PRESS: neither file records editing, so `exes/fida/src/ops/editing.rs` (not FID-A; Osprey's `osp_onOffClassifyMEGA` rule) splits alternate transients, classifies edit-ON/OFF by NAA/Cr and inversion by creatine, and brings them to FID-A's Siemens layout before `run_megapressproc_auto`. The Philips path is validated against FID-A's `io_loadspec_sdat(..., 2)` and pipeline (`ref_mega_philips.m`). FID-A's GE MEGA sample has 8-transient sums whose edit states cancel; there is no openly licensed GE MEGA example with alternating frames yet.
- The Siemens SPECIAL example's header was de-identified (name, ID, birth date overwritten with same-length placeholders) before upload; do the same for any new raw-data example.

## zarro

- Uses the registry `@niivue/niivue` with no patch. Everything the old rc.11 patch provided is upstream API as of `1.0.0-rc.14` ([niivue/mono#160](https://github.com/niivue/mono/issues/160)); see `docs/architecture/zarro-niivue-streaming-integration.md` for the mapping. Do not reintroduce `patchedDependencies` or reach into NiiVue internals; ask upstream for an API instead.
- `src/cursor_zoom.ts` stays until NiiVue exports its wheel-zoom anchor helpers or a configurable wheel step, because the Scroll zoom speed setting needs a continuous zoom. `src/nvslide_measurement.ts` stays until NVSlide scalar tiles land upstream (niivue/mono#159).

## Upstream apps (qsmbly, seedseg, dicompare)

- These apps are copies of Ashley Stewart's repositories, which stay the source. `source:` in
  `registry/apps.yml` pins the upstream commit each copy last merged; `apps/<id>/upstream.json`
  lists upstream paths not imported, path and identifier rewrites, and the adaptations to keep.
- `.github/workflows/upstream-sync.yml` runs `scripts/sync-upstream.mjs` weekly and opens one PR per
  app on `upstream/<id>`: a three-way merge from the pinned commit, monorepo date versions kept,
  conflict markers left in a draft PR. Resolve conflicts on that branch; once a person has pushed
  to it the workflow stops overwriting it until it is merged or deleted. It pushes with the
  `neurodesk-webapps-upstream-sync` GitHub App so CI runs on its PRs ([setup](docs/architecture/upstream-sync.md)).
- Upstream files the monorepo deleted (replaced by shared code) stay deleted; their upstream
  changes are listed in the PR, not applied. Port anything relevant to the shared code by hand.
- The standalone bundle serves the dicompare worker, controller and the QSM/SeedSeg schemas from
  `apps/dicompare/public`, not from dicompare.neurodesk.org (`path` entries in
  `registry/offline-assets.sources.json`).

## dcm2niix

- Every app converts with the one `@niivue/dcm2niix` version pinned exactly in `packages/runtime-support` (also `packages/lcmodel`, `packages/mri2vid`, `apps/dicompare`; bump them together). Bundled apps import `@neurodesk/runtime-support/dcm2niix-client` (`readImageFiles`, `readImageSeries`, `readDiffusionSeries`, `runDcm2niix`); bundler-less apps use the shared `DicomController`/`createDicomConverter` on `dcm2niix/index.jpeg.js`, which `scripts/vendor-runtime-support.mjs` stages from npm in each such app's `prebuild` (`test/shared-imaging-refactor.test.mjs` enforces it). Never commit a dcm2niix build or write app-local conversion glue.
- Every path passes `-f %p_%t_%s`: dcm2niix 1.4's default name starts with the input folder, which can name a patient, and downloads derive from output names. Upstream has no default deadline; the shared paths set 120 s.
- The `read*` functions keep partial output (some series failed) and throw only when no image is produced; `runDcm2niix` rejects any exit code but 0 or 3.
- The 1.4 glue is browser-only: Node passes the sibling `.wasm` as `wasmBinary` (`@neurodesk/node-drivers/dcm2niix` takes the glue URL and does this).
- The composite site shares one `dcm2niix-jpeg` WASM family (`runtime-assets/manifest.json`); each app keeps its worker and glue in its own service-worker scope. A version bump changes its sha256 there.
- dwi2trx keeps its own drop walker (`src/dwi2trx/files.ts`) because it stops at 20 000 files during the walk; upstream's walker has no limit.

## Node drivers for command lines (MindGrab, niimath)

- A portable command line that needs MindGrab or niimath uses `@neurodesk/node-drivers/mindgrab`
  (`loadMindgrabCpu`) or `/niimath` (`runNiimath`), not the browser wrappers and not shimmed browser
  globals. Both take the build the caller pins (`import.meta.resolve('@brainchop/mindgrab/package.json')`,
  the `@niivue/niimath/niimath.js` factory), so pin the app's own version in the command line's package.
  The MindGrab result has the wrapper's shape, so pass `mindgrab.segment` where code takes a `segmenter`.
- One MindGrab call peaks at 2.6 GB (mindgrab) to 3.9 GB (mindmap tissues) and uses one thread per core.
  The driver runs each call in its own worker thread, so memory is freed when it ends, and queues calls
  within a process; do not start MindGrab in two processes at once.
- `packages/node-drivers/bin/brainchop-mindgrab.js` is the native brainchopC command line on the CPU
  driver, for Linux containers (meica-rs `--moco`, fastprep). Its parser (`src/mindgrab-cli.js`) mirrors
  the native one, which the CPU module prints with `--help`; a MindGrab bump that adds a native option
  fails its tests until the option is accepted or refused.
- `packages/node-drivers/validation/reference.json` pins the browser outputs both drivers reproduce byte
  for byte. After bumping either devDependency there, rerun `pnpm --filter @neurodesk/node-drivers
  exec node validation/browser-reference.mjs` and commit the new references; `node-drivers.yml` checks
  them on Linux, Windows and macOS. A command line's own release check still needs its own independent
  reference.

## me-ica

- The engine is `@niivue/meica` from [niivue/meica-rs](https://github.com/niivue/meica-rs) (Rust port of tedana; its `DEVELOPMENT.md` and `AGENTS.md` hold the equivalence tests and numerics). `package.json` pins the exact npm version. Before a PR, after that version is on npm, run `pnpm install` so `pnpm-lock.yaml` resolves it from the registry, not a local `link:`. `apps/me-ica` stages only the package's `dist/single` (`scripts/copy-runtime.mjs` → ignored `public/meica-wasm/`) and runs it single-threaded in `src/worker.js`; cancelling terminates that worker. Never deploy `dist/threaded`: it links Apache-2.0 wasm-bindgen-rayon, pending a legal determination (meica-rs `AGENTS.md`).
- `e2e/expected.json` pins the sha256 of key outputs recorded from the native `meica` CLI on the examples; the browser must reproduce them. Re-record when a meica release changes outputs. `ME_ICA_EXAMPLE_DIR` serves the first example locally instead of HF. `playwright.config.js` always blocks service workers: the coi worker hides requests from `page.route`, and the preview server sends COOP/COEP itself.
- The examples (`examples.json`) are on HF dataset `neurodeskorg/webapps`, `me-ica/motor-3echo{,-moco}/example/`, pinned with both offline inventories (`scripts/lock-example-assets.mjs`).
- T2* uses a fixed 0–0.1 s window (`T2STAR_WINDOW`, `src/main.js`): tedana caps fits at 10× the 99.5th percentile, so outliers to ~600 s wash out NiiVue's auto window.
- The component "stat-z" maps are tedana's standardized regression weights (mostly within ±0.7), not z statistics; the viewer overlays them on S0 from |0.3| to 0.7.
- Needs 3+ echoes (`MIN_ECHOES`; tedana's PCA fails with 2).
- The regressors TSV comes from the dropped files (`*_desc-confounds_timeseries.tsv`, else a single non-events TSV; `src/inputs.js`) and is sent only for trees in the "Needs a confounds TSV" menu group. The moco example ships its confounds; e2e checks motion_aroma against native hashes.

## pipeline-builder

- Validation is NeuroFlow's core, vendored as WASM (`vendor/neuroflow/README.md`, `provenance.json`). Import/export keeps the workflow's `neuroflow` version; 0.1.0 or missing becomes 0.1.1.
- NeuroFlow core v0.6.0 reports undeclared `inputs.<name>` refs (`input-undeclared`) and invalid constants (`constant-invalid`: type, integer, enum, min/max). v0.7.0 adds `local-id-invalid` for input, context field, step and output names outside the spec's `localId` grammar, and `output-ref-not-step`; the builder has no copy of either. The builder's `constant-invalid` check in `workflowIssues` stays for the per-item limits in `neurodesk/parameter`; `validator.js` drops it where the core already reported that path. PR #648 also adds typed array parameters and import shape checks in `parseWorkflow`.
- Optional-output warnings come only from the core (v0.3.2 matches the removed builder check on every catalog binding).
- Open: `bindNewWorkflowInput` drops item bounds; carrying `minItems`/`maxItems` needs the generator to emit them and a 0.1.2 document. If it does, the core's item-count issue will duplicate the builder's `input-count` warning.

## Native executables (exes/)

A `packages/<app>/release.json` with a `tag` is an external release: another repository builds and releases it, and `externalCatalog` (`scripts/lib/native-releases.mjs`) turns its pinned assets into the app's `registry/standalone.json` entry, which `test/standalone.test.mjs` holds equal. Nothing here builds, dispatches or imports it. To move to a new release, update the pins and run `node scripts/desktop/import-native-releases.mjs`, which rewrites external entries from their pins without fetching them.

`exes/<app>` holds native Rust executables, not pnpm packages. `exes/synthsr`
builds with `make` inside that directory (`check-model`, `build`, `test`,
`test-real`, `macos-release`), not `pnpm`. Model assets come from the Hugging
Face dataset `neurodeskorg/webapps` via a pinned manifest and are never
committed.

`exes/greedy` is the native Rust Greedy workspace and the source of the browser
module. `packages/greedy` owns the JavaScript wrapper and ignored threaded
`wasm-bindgen` build output; rebuild it with
`pnpm --filter @neurodesk/greedy build:wasm`. Apps stage the complete generated
directory because its Rayon worker helper, JavaScript glue and WASM binary use
relative URLs and must remain adjacent. The versioned Greedy web release carries
that generated runtime; it is never committed or npm-published. Greedy's app
manifest is the release version source; the release tooling keeps its package
and Rust workspace at the same `MAJOR.MINOR.YYYYMMDD` version, except the `greedy-rs-core` and
`greedy-rs-wasm` crates, which stay at `0.0.0` because their versions end up in the committed
`wasm-single` bytes.

`packages/greedy/wasm-single` is a single-threaded build of the same crate, which SYNcro's command
line runs in Node (`@neurodesk/greedy/single`). It gives the threaded browser build's results byte
for byte (checked in Chromium on a BISON pair), and it is committed so that every platform runs the
same bytes. After changing `exes/greedy/core` or `exes/greedy/wasm`, run
`pnpm --filter @neurodesk/greedy build:wasm-single` on Linux (binaryen `version_117` wasm-opt on `PATH`) and commit the result; the
`wasm-single` job in `greedy-native.yml` fails when a rebuild differs.

`exes/fastprep` and `exes/glm` are Cargo workspaces (`make build test lint`) with `cli`, `core` and `wasm` crates. `pnpm --filter @neurodesk/fastprep build:wasm` builds both WASM crates into the gitignored `packages/fastprep/wasm`. There is no bundled CLI release yet: fastprep is in `registry/standalone-exceptions.json` until niimath, brainchop, greedy-rs, synthsr, topofit and glm are packaged and TopoFit's licence allows it.

`exes/compute-server` is the `neurodesk-compute` server (`make build test lint fmt`,
`make run-simulated`). It has no GPU or Docker dependency at build or test time; all
tests use the simulated runner. `.github/workflows/compute-server-native.yml` builds
and tests it on Linux, Windows and macOS and uploads archives.

`exes/synthseg` is the SynthSeg 2.0 CLI (ORT CPU + native Metal), imported
from a standalone repo. Its `README.md` "Numerics" and "Traps" sections are the
maintainer contract: preprocessing is f64, gates in `tests/parity.rs` only
tighten. The Metal executor includes `packages/synthseg/src/gpu-model.json`
(written by `make export`); `build.rs` verifies the model against
`packages/synthseg/model.manifest.json`. `make test-real` fetches inputs and
FreeSurfer goldens from Hugging Face into `SYNTHSEG_REFERENCE_DIR`.

`packages/synthseg/wasm/src/lib.rs` includes `exes/synthseg/src/{nifti,volume,post}.rs`
by `#[path]`, so browser pre/postprocessing is the CLI's code, not a port. The
built `src/synthseg.wasm` is committed: after changing those Rust files run
`make wasm` and `make test` in `packages/synthseg`. `apps/synthseg` is WebGPU-only
(no WASM inference fallback); its e2e parity gate mirrors `tests/parity.rs`.

Deferred SynthSeg cleanups (audit 2026-09-10):
share the CLI shell/NIfTI decode/volume math with `exes/synthsr` in one crate; drop the
`metal-f16` feature and unused `scripts/{compare_seg,check_onnx}.py`; the per-run
`is_finite` scan in `main.rs` is on the hot path.

`exes/synthsr/src/nifti.rs` and `src/volume.rs` are line-for-line ports of
`packages/synthsr/src/volume.js` and must stay bit-identical (f64 math, f32
storage): change the JS and the Rust together. `exes/synthsr/src/metal.rs`
mirrors the shared WebGPU executor in
`packages/runtime-support/src/gpu-unet/` the same way;
`exes/synthseg/src/metal.rs` mirrors that same executor including its `Concat`
and `Softmax` kernels and the padded classifier head.
