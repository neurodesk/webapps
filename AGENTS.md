# Repository instructions

This repository stores source code only. Large validation datasets and models belong on [https://huggingface.co/datasets/neurodeskorg/webapps](https://huggingface.co/datasets/neurodeskorg/webapps). Every app is versioned `MAJOR.MINOR.YYYYMMDD`: the patch is the UTC release date (e.g. `0.1.20260808`). Describe changes in a changeset (`pnpm changeset`), then run `pnpm release`, which sets the date versions, writes changelogs and synchronises embedded version strings (`scripts/lib/app-versions.mjs`); `test/app-versions.test.mjs` rejects any other scheme. Keep scratch files off `/tmp`: `TMPDIR` points at the storage volume and turbo passes it through.

## Interface changes and new applications

Before changing UI, adding controls, or scaffolding an app, read [the design system](docs/architecture/design-system.md) and [the interface standard](docs/architecture/interface-standard.md). QSMbly is the visual reference; the design system is its metrics expressed as one shared vocabulary.

- Build every sidebar, viewer, console, status bar and dialog from the classes in `@neurodesk/webapp-components/styles/imaging-workspace.css` and the custom elements and native builders in `@neurodesk/webapp-components/ui` (`createFileField`, `createViewerToolbar`, `createConsole`, `createInfoDialog`, `createResultList`). Start from `templates/app-template`, which is the complete canonical layout.
- Do not write app CSS for those regions, hardcode colours, override `--nd-color-*` tokens, set `color-scheme`, or add `<dialog>` markup. If the vocabulary lacks something, add it to the shared stylesheet with a test, then use it. `test/design-system.test.mjs` fails on each of these.
- Keep sources readable: one rule or statement per line. Minified app HTML, CSS or JS hides drift from review.
- About and Cite content is data in `registry/app-information.yml` (the lightNIIng ecosystem statement and link live under `shared`) (packages under the hood, a paper per implemented method, builder credits). The shared shell renders it; apps never write citation markup. When an app gains a method, add its paper there and to `test/app-information.test.mjs`.

- Keep one shared application bar. Register app-specific About, Cite and Privacy handlers through the shell's control contract. If an app ships a command-line package, register its Standalone instructions through the optional shell control instead of placing them in the workflow sidebar.
- Keep the current task visible. Put optional settings, technical logs and inactive output controls in accessible collapsible sections.
- Place technical logs in a collapsed console below the viewer, following QSMbly's `console-container` disclosure pattern. Keep Copy and Clear actions in the console header.
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
  grouping follows QSMbly, per the interface standard.
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

## dwi2trx

- WebGPU-only app (diffusion tensor fitting + GPU streamline tractography); it throws a clear error at startup on a browser without WebGPU, and streamline tracking additionally requires `subgroups` support.
- `package.json` pins `@niivue/niimath` to the vendored `file:./vendor/niimath` build (dtifit-enabled). Do not replace it with the registry `@niivue/niimath` package until a dtifit-enabled build lands upstream.
- `public/brainchop/` is generated by `scripts/copy-brainchop.mjs` (stages `@brainchop/mindgrab`'s WebGPU assets for runtime fetch) and is gitignored — regenerate it via `dev`/`build`, don't hand-edit or commit it.
- TypeScript unit tests under `src/` run with `node --experimental-strip-types`, not a bundler.
- The Playwright e2e smoke test needs a WebGPU-capable Chromium.

## brain2print

- WebGPU-only app (MindGrab segmentation + niimath meshing); it reports a clear status error at startup on a browser without WebGPU.
- `public/brainchop/` is generated by `scripts/copy-brainchop.mjs` (stages `@brainchop/mindgrab`'s `16chan18cls` WebGPU/WebGL assets for runtime fetch) and is gitignored — regenerate it via `dev`/`build`, don't hand-edit or commit it.
- `src/mesh.js` is the pure, Node-tested mesh check; the two pipeline e2e tests (right- and left-handed fixture) need a hardware WebGPU adapter and run only on macOS. Mesh outputs (`*.stl`, `*.obj`, `*.mz3`) are gitignored; reference data goes to Hugging Face.

## ants

- Greedy's interface driving the ANTs SyN WebAssembly kernel from `packages/registration` (the same kernel and ANTsPy `SyN` schedule as SYNcro); the worker inflates gzipped NIfTI before writing `.nii` because ANTs reads by file name.
- `public/registration/` and `public/brainchop/` are generated by `scripts/copy-runtime.mjs` before `dev`/`build` and are gitignored. Registration does not auto-run on load: SyN on the 1 mm examples takes about a minute on an M4 Pro.

## topofit

- `apps/topofit/src/stl-worker.js` imports `@niivue/niimath/niimath.js` (the package's raw Emscripten
  export) and calls `callMain` directly instead of the fluent `Niimath`/`.mesh()` API: that API's `run()`
  always appends `-odt <type>` as the final argv, but niimath mesh mode reads the *last* argv as the
  output filename, so the fluent API cannot select mz3 output. The pinned `@niivue/niimath@1.4.20260909`
  WASM build is also compiled without `HAVE_FORMATS`, so it can only write `.mz3`; `packages/topofit/src/results.js`
  round-trips mz3 and writes STL itself. Both are fixed upstream in `~/src/niimath` for the release after
  1.4.20260909 — once that ships, drop the direct `callMain` path and `writeMz3`/`readMz3` for the fluent
  API's own STL output.

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
  full-resolution atlas, geometry from a 20 % decimation. `apps/disconnectome` says so in
  About; keep that distinction if either file changes.
- NiiVue rc.13 is required, not the patched rc.11 most apps pin: `setTractOptions`'s
  `groupColors` (colour and visibility per TRX group, in one call) and `dps` arrived in rc.13.
  The 3D clip plane is load-bearing, not decoration: without it the opaque volume render hides
  every bundle inside the brain.
- The Standalone bar action belongs to the shell and renders `registry/standalone.json`; an app
  cannot replace it with its own dialog. Every registered app needs an entry there or the
  catalog check fails.
- Examples are declared once, in `apps/disconnectome/examples.json`, which the shared
  `nd-example-selector` downloads and checksums. Re-pinning the dataset changes every URL, so
  after `repoint_manifest.sh` run `apps/disconnectome/scripts/sync-examples.mjs` and then
  `scripts/lock-example-assets.mjs`, dropping the old revision's entries from the offline
  inventory first.

## Native executables (exes/)

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
and Rust workspace at the same `MAJOR.MINOR.YYYYMMDD` version.

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
share the CLI shell/NIfTI decode/volume math with `exes/synthsr` in one crate; route both
apps' worker model download through `packages/components` `fetchModel`; drop the
`metal-f16` feature and unused `scripts/{compare_seg,check_onnx}.py`; the per-run
`is_finite` scan in `main.rs` is on the hot path.

`exes/synthsr/src/nifti.rs` and `src/volume.rs` are line-for-line ports of
`packages/synthsr/src/volume.js` and must stay bit-identical (f64 math, f32
storage): change the JS and the Rust together. `exes/synthsr/src/metal.rs`
mirrors the shared WebGPU executor in
`packages/runtime-support/src/gpu-unet/` the same way;
`exes/synthseg/src/metal.rs` mirrors that same executor including its `Concat`
and `Softmax` kernels and the padded classifier head.
