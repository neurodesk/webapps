# Third-party notices

QSMbly is MIT-licensed (see [LICENSE](LICENSE)). This file records the third-party code that is
committed to this repository, so it is clear which upstream release each copy came from and under
which license it is redistributed. When you update one of these, update its entry here too.

## Vendored in this repository

| Path | Project | Version | License |
|---|---|---|---|
| `niivue/index.js` | [NiiVue](https://github.com/niivue/niivue) (`@niivue/niivue`), unminified ES module bundle | not recorded; the file matches no published `dist/index.js` from 0.51.0 to 0.57.0 | BSD-2-Clause |

DICOM conversion (dcm2niix) and cross-origin isolation (coi-serviceworker) come from the
shared `@neurodesk/webapp-components` and build tooling of this repository, not from copies in
this directory.

## Loaded from a CDN at runtime

These are not committed. Tagify is pinned to an exact version with subresource integrity in
`index.html`, and the Inter font files to exact URLs in `css/inter.css`:

| Library | Version | License |
|---|---|---|
| [Tagify](https://github.com/yairEO/tagify) (`@yaireo/tagify`) | 4.39.0 | MIT |
| [Inter](https://rsms.me/inter/) font, via Google Fonts | v20 files | SIL Open Font License 1.1 |
