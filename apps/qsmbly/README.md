# QSMbly: Browser-Based Quantitative Susceptibility Mapping

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![GitHub Pages](https://img.shields.io/badge/GitHub%20Pages-Ready-green.svg)](https://pages.github.com/)
[![WebAssembly](https://img.shields.io/badge/WebAssembly-Powered-blue.svg)](https://webassembly.org/)

A complete **Quantitative Susceptibility Mapping (QSM)** pipeline that runs entirely in your web browser using WebAssembly. No installation, no backend servers, no data uploads — just pure client-side MRI processing.

[ACCESS QSMbly HERE](https://qsmbly.neurodesk.org/)

This application integrates [Ashley Stewart's upstream QSMbly](https://github.com/astewartau/qsmbly)
at the commit pinned by `source:` in `registry/apps.yml`. The shared shell, example
catalog, worker channels and release tooling belong to this repository.

The weekly `upstream sync` workflow merges new upstream commits into a pull request.
[upstream.json](upstream.json) lists the upstream files this app does not import and
the adaptations to keep when resolving conflicts. To run it locally, use
`node scripts/sync-upstream.mjs --app qsmbly`.

## Features

- **Private**: All processing happens locally in your browser — your images are never uploaded (see [What leaves your browser](#what-leaves-your-browser))
- **Zero Installation**: No Python, MATLAB, or specialized software required
- **Cross-Platform**: Works on Windows, macOS, Linux, and even mobile devices
- **Interactive**: Real-time visualization with NiiVue, adjustable contrast, and masking thresholds
- **Portable**: Static files can be hosted anywhere (GitHub Pages, local server, etc.)
- **Comprehensive**: 20+ algorithms covering the complete QSM pipeline

## What leaves your browser

Your images never do. Files you load are read into browser memory and processed by WebAssembly in a
Web Worker on your machine; the app never uploads them. Results are only saved where you choose to
download them.

The page does make some network requests of its own. None of them carries image data:

- **Cloudflare Web Analytics.** A beacon (`static.cloudflareinsights.com`) records an anonymous page
  view: the usual visitor metadata such as country, referrer and browser. It sets no cookies.
- **Fonts and libraries.** The Inter font comes from Google Fonts, and the Tagify and NiiVue
  libraries from the unpkg CDN. These services see the request like any other web request.
- **The QSMxT navigation bar.** `qsm-nav.js` is loaded from `qsmxt.github.io`.
- **Deep-learning model weights**, downloaded from Hugging Face (`huggingface.co/qsmxt`) the first
  time you run a deep-learning method, then cached in your browser's IndexedDB.
- **Example data**, downloaded from Hugging Face only if you click to load it.
- **dicompare**, the protocol checker, which loads its code and the QSM consensus schema from
  `dicompare.neurodesk.org`, and when run, Pyodide from jsDelivr and the `dicompare` Python package
  from PyPI. The DICOM headers it checks are read in your browser.

Deep-learning methods and dicompare therefore need an internet connection the first time they are
used; the rest of the pipeline works offline once the page has loaded.

## Algorithms

QSMbly's QSM algorithms are provided by [QSM.rs](https://github.com/astewartau/QSM.rs), a standalone Rust library compiled to WebAssembly. See the [QSM.rs README](https://github.com/astewartau/QSM.rs#algorithms) for a complete list of supported algorithms with citations.

## Quick Start

### Option 1: Use Online
1. Visit [qsmbly.neurodesk.org](https://qsmbly.neurodesk.org/)
2. Upload DICOM files or NIfTI magnitude/phase images
3. Set acquisition parameters (Echo Time, Field Strength)
4. Run the pipeline

### Option 2: Run Locally
```bash
git clone https://github.com/neurodesk/webapps.git
cd webapps
corepack enable
pnpm install
pnpm --filter qsmbly dev
# Open http://localhost:8080
```

## Building from Source

### Prerequisites
1. **Install Rust**: https://rustup.rs/
2. **Install wasm-pack**:
   ```bash
   cargo install wasm-pack
   ```
<<<<<<< monorepo
3. Install the pinned toolchain for threaded WASM:
   ```bash
   rustup toolchain install nightly-2025-11-15 --component rust-src --target wasm32-unknown-unknown
   ```

### Build and Run
```bash
# Threaded classical and lazy-loaded deep-learning bundles
=======
3. **Install the nightly toolchain** (the default threaded build rebuilds `std` with atomics):
   ```bash
   rustup toolchain install nightly --component rust-src
   ```
   Not needed with `--no-threads`.
4. **Node.js** (generates the algorithm defaults) and **Python 3** (patches the threaded
   worker helper, and runs the development server).

### Build and Run
```bash
# Standard threaded build
>>>>>>> upstream
./build.sh

# SIMD-accelerated build (faster, requires modern browsers)
./build.sh --simd

<<<<<<< monorepo
# Single-threaded bundles for hosts without cross-origin isolation
./build.sh --no-threads

# Start development server
./run.sh
```

Run `pnpm --filter qsmbly build` from the repository root to assemble the themed
production application. The deep-learning bundle always uses SIMD128. Model
weights download on first use from a pinned Hugging Face revision and are checked
against the QSM.rs model registry's sizes and SHA-256 hashes.
=======
# Single-threaded build (stable toolchain; runs on any static host)
./build.sh --no-threads

# Flags combine in any order, e.g.
./build.sh --no-threads --simd

# Start the development server on http://localhost:8080
./run.sh
```

`run.sh` runs `serve.py`, which sends the cross-origin-isolation (COOP/COEP) headers that
threaded WASM needs and disables caching so a rebuilt bundle is always picked up. It listens
on `127.0.0.1` only; pass a host to expose it, e.g. `./run.sh 8080 0.0.0.0`.
>>>>>>> upstream

### SIMD Acceleration

The `--simd` flag enables 128-bit SIMD vectorization for faster processing of iterative algorithms. This provides approximately **2-4x speedup** for element-wise operations.

| Browser | Minimum Version |
|---------|-----------------|
| Chrome  | 91+ (May 2021)  |
| Firefox | 89+ (June 2021) |
| Safari  | 16.4+ (March 2023) |
| Edge    | 91+ (May 2021)  |

### Running Tests
```bash
pnpm --filter qsmbly test
pnpm --filter qsmbly test:examples
pnpm --filter qsmbly test:e2e
```

<<<<<<< monorepo
Run these commands from the repository root. Browser tests download the pinned
brain example and xQSM weights, reconstruct an image, and check the About link
and HD-BET controls. They verify workflow execution, not the accuracy of every
available reconstruction model.
=======
## Deployment

Two environments, both served from GitHub Pages out of the `gh-pages` branch, which holds each as
an independent subtree:

| | URL | Deployed from | When |
|---|---|---|---|
| Release | [qsmbly.neurodesk.org](https://qsmbly.neurodesk.org/) | `main` | a GitHub release is published |
| Staging | [qsmbly.neurodesk.org/staging](https://qsmbly.neurodesk.org/staging/) | `staging` | every push to the branch |

The intended flow is: open feature PRs against `staging`, look at the result on the staging site,
then PR `staging` into `main` and cut a release from there. A staging deploy never touches the
released site, and publishing a release never rolls staging back.

Both go through `.github/workflows/build-pages.yml`, so there is one definition of what a
deployable site contains; `deploy.yml` and `deploy-staging.yml` differ only in which ref they
build, which version they stamp, and which subtree they own. `scripts/publish-pages.sh` does the
publishing and will refuse to replace the site root if that would delete a subtree it was not told
to keep.

Notes:

- The staging build is stamped `0.0.0-staging.g<sha>`. That string is not decoration: the wasm
  fetch is cache-busted by the app version, so a fixed staging version would serve a cached
  bundle against new JavaScript.
- Staging is excluded from search engines via `robots.txt` at the site root.
- Pushing to `staging` deploys regardless of whether the test suite passes — it is a place to look
  at work in progress. CI still runs on the branch and on PRs into it.
>>>>>>> upstream

## Repository Structure

```
qsmbly/
├── index.html              # Landing page and application interface
├── coi-serviceworker.js    # Adds COOP/COEP headers on static hosts (cross-origin isolation)
├── build.sh                # WASM build script
├── run.sh                  # Development server (wraps serve.py)
├── serve.py                # Static server with COOP/COEP + no-cache headers
├── test.sh                 # Rust test runner
├── js/
│   ├── qsm-app-romeo.js    # Main application logic
│   ├── qsm-worker-pure.js  # Web worker for pipeline execution
│   ├── app/                # Configuration and algorithm defaults (qsm-defaults.js is generated)
│   ├── controllers/        # UI controllers (file I/O, DICOM, masking, pipeline, viewer)
│   ├── modules/            # File I/O, masking, model weights, UI (landing page, tour, modals)
│   └── worker/utils/       # Helpers used by the pipeline worker
├── css/
│   ├── modern-styles.css   # Application styling
│   ├── landing.css         # Landing page styling
│   ├── app.css             # Modals, pipeline settings and other app components
│   └── a11y.css            # Accessibility tweaks (keyboard-operable accordion headers)
├── assets/                 # App screenshot (written by scripts/capture-landing-shot.mjs)
├── scripts/                # Defaults generator, Pages publishing, landing screenshot, benchmarks
├── wasm/                   # Compiled WebAssembly (built by build.sh, served to the browser)
├── rust-wasm/              # WASM binding layer
│   ├── Cargo.toml          # Depends on qsm-core
│   └── src/lib.rs          # Thin wasm_bindgen wrappers around QSM.rs
├── dcm2niix/               # DICOM-to-NIfTI conversion (WASM)
└── nifti-js/               # NIfTI reader (JavaScript)
```

Versions and licenses of the vendored third-party code are recorded in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Technical Stack

- **[QSM.rs](https://github.com/astewartau/QSM.rs)**: Core QSM algorithms (Rust, compiled to WebAssembly)
- **[wasm-bindgen](https://github.com/rustwasm/wasm-bindgen)**: JavaScript/WASM interop
- **[NiiVue](https://github.com/niivue/niivue)**: WebGL neuroimaging viewer
- **[dcm2niix](https://github.com/rordenlab/dcm2niix)**: DICOM conversion (WASM build)
- **[NIFTI-Reader-JS](https://github.com/rii-mango/NIFTI-Reader-JS)**: NIfTI parsing
- **[Tagify](https://github.com/yairEO/tagify)**: Echo-time input
- **[coi-serviceworker](https://github.com/gzuidhof/coi-serviceworker)**: Cross-origin isolation on static hosts

## License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.

## Issues & Support

- **Bug Reports**: [GitHub Issues](https://github.com/neurodesk/webapps/issues)
- **Feature Requests**: [GitHub Discussions](https://github.com/neurodesk/webapps/discussions)
