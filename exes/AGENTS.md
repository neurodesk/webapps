# Native executables (exes/) instructions

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

See also [exes/compute-server/AGENTS.md](compute-server/AGENTS.md), [exes/nii2tvx/AGENTS.md](nii2tvx/AGENTS.md), [exes/lcmodel/AGENTS.md](lcmodel/AGENTS.md), [exes/fida/AGENTS.md](fida/AGENTS.md), and any `apps/<id>/AGENTS.md` for app-paired Rust/WASM crates (`deconvolution`, `samsrf`, `fastprep`).
