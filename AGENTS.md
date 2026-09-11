# Repository instructions

This repository stores source code only. Large validation datasets and models belong on [https://huggingface.co/datasets/neurodeskorg/webapps](https://huggingface.co/datasets/neurodeskorg/webapps). Every app is versioned `MAJOR.MINOR.YYYYMMDD`: the patch is the UTC release date (e.g. `0.1.20260808`). Describe changes in a changeset (`pnpm changeset`), then run `pnpm release`, which sets the date versions, writes changelogs and synchronises embedded version strings (`scripts/lib/app-versions.mjs`); `test/app-versions.test.mjs` rejects any other scheme. Keep scratch files off `/tmp`: `TMPDIR` points at the storage volume and turbo passes it through.

## Interface changes and new applications

Before changing UI, adding controls, or scaffolding an app, read [the design system](docs/architecture/design-system.md) and [the interface standard](docs/architecture/interface-standard.md). QSMbly is the visual reference; the design system is its metrics expressed as one shared vocabulary.

- Build every sidebar, viewer, console, status bar and dialog from the classes in `@neurodesk/webapp-components/styles/imaging-workspace.css` and the builders in `@neurodesk/webapp-components/ui` (`renderFileField`, `renderViewerToolbar`, `renderConsole`, `createInfoDialog`, `StageResultList`). Start from `templates/app-template`, which is the complete canonical layout.
- Do not write app CSS for those regions, hardcode colours, override `--nd-color-*` tokens, set `color-scheme`, or add `<dialog>` markup. If the vocabulary lacks something, add it to the shared stylesheet with a test, then use it. `test/design-system.test.mjs` fails on each of these.
- Keep sources readable: one rule or statement per line. Minified app HTML, CSS or JS hides drift from review.
- About and Cite content is data in `registry/app-information.yml` (the lightNIIng ecosystem statement and link live under `shared`) (packages under the hood, a paper per implemented method, builder credits). The shared shell renders it; apps never write citation markup. When an app gains a method, add its paper there and to `test/app-information.test.mjs`.

- Keep one shared application bar. Register app-specific About, Cite and Privacy handlers through the shell's control contract. If an app ships a command-line package, register its Standalone instructions through the optional shell control instead of placing them in the workflow sidebar.
- Keep the current task visible. Put optional settings, technical logs and inactive output controls in accessible collapsible sections.
- Place technical logs in a collapsed console below the viewer, following QSMbly's `console-container` disclosure pattern. Keep Copy and Clear actions in the console header.
- Reuse shared layout, spacing and control components. Preserve input values when sections close.
- Before completing UI work, run `pnpm audit:interfaces`, `pnpm test:mobile` and `pnpm test:interface-workflows` against a fresh production build. Review desktop and phone screenshots and exercise the changed workflow. The interface standard defines the review criteria and the audit's limits.

For catalog-wide work, use [the interface audit](docs/architecture/interface-audit.md) to track remaining changes per app. Update its findings when resolving them.

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

## Native executables (exes/)

`exes/<app>` holds native Rust executables, not pnpm packages. `exes/synthsr`
builds with `make` inside that directory (`check-model`, `build`, `test`,
`test-real`, `macos-release`), not `pnpm`. Model assets come from the Hugging
Face dataset `neurodeskorg/webapps` via a pinned manifest and are never
committed.

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
