# Third-party notices

QSMbly is MIT-licensed (see [LICENSE](LICENSE)). This file records the third-party code that is
committed to this repository, so it is clear which upstream release each copy came from and under
which license it is redistributed. When you update one of these, update its entry here too.

## Vendored in this repository

| Path | Project | Version | License |
|---|---|---|---|
| `nifti-js/nifti-reader-min.js` | [NIFTI-Reader-JS](https://github.com/rii-mango/NIFTI-Reader-JS) (npm `nifti-reader-js`) | 0.5.4 | MIT |
| `dcm2niix/dcm2niix.js`, `dcm2niix/dcm2niix.wasm` | [dcm2niix](https://github.com/rordenlab/dcm2niix), WebAssembly build from [`@niivue/dcm2niix`](https://www.npmjs.com/package/@niivue/dcm2niix) | `@niivue/dcm2niix` 1.3.20260724 (reports dcm2niix v1.0.20260724) | BSD-2-Clause |
| `dcm2niix/index.js`, `dcm2niix/worker.js` | Wrapper from the same `@niivue/dcm2niix` package | unknown; derived from the package's `dist/` files, with local differences | BSD-2-Clause |
| `coi-serviceworker.js` | [coi-serviceworker](https://github.com/gzuidhof/coi-serviceworker) | banner says v0.1.7, but the file is the later upstream `master` build (identical to `coi-serviceworker.min.js` at commit [`4dadf68`](https://github.com/gzuidhof/coi-serviceworker/commit/4dadf68), December 2023), which adds the COEP-degrade fallback | MIT |

How the versions were determined:

- `nifti-reader-min.js` is byte-identical to `release/current/nifti-reader-min.js` in the
  `nifti-reader-js@0.5.4` npm package. The file has no version banner.
- `dcm2niix.wasm` is byte-identical to `dist/dcm2niix.wasm` in `@niivue/dcm2niix@1.3.20260724`; see
  also [dcm2niix/README.md](dcm2niix/README.md). The wrapper scripts differ from that release's
  `dist/index.js` and `dist/worker.js` and were not traced to a specific earlier release.
- `coi-serviceworker.js` matches upstream `master`, not the v0.1.7 npm release.

## Loaded from a CDN at runtime

These are not committed, but are pinned to an exact version with subresource integrity in
`index.html`:

| Library | Version | License |
|---|---|---|
| [Tagify](https://github.com/yairEO/tagify) (`@yaireo/tagify`) | 4.39.0 | MIT |
| [NiiVue](https://github.com/niivue/niivue) (`@niivue/niivue`) | 0.57.0 | BSD-2-Clause |
| [Inter](https://rsms.me/inter/) font, via Google Fonts | served by Google | SIL Open Font License 1.1 |
