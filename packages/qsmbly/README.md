# QSMbly command line

QSMbly builds QSMxT commit `999445010a067d9597299f217a9a1165d4b7d62d`
with QSM.rs `046e2e3bd21b1f35ce2760c115145c52956645a2`, matching the browser.
Upstream reports version `0.0.0`; this is not the published 10.0.0 executable.
Use the exported command together with its exported TOML configuration.
The schema version and V-SHARP radius step must be preserved: legacy migration
otherwise selects a different radius step.

The packaged default-feature build passes the unchanged reference bounds (correlation
0.999548, RMS 0.000283 ppm). The portable packaging check repeats the comparison on each target.

`qsmxt.json` pins the source archive checksum and Rust toolchain. Staging builds
with `cargo build --locked --release` on each target. The checksum-pinned 10.0.0
archives supply dcm2niix and its license only; staging replaces qsmxt with the
source build and records `native/source.json`. Linux builds require the build
host's glibc baseline (CI uses Ubuntu 22.04). Windows and macOS build natively.
`npm pack` runs staging too.


`bin/qsmbly.js` adds two commands and guards native QSMxT execution:

- `self-check` prints the runtime and QSMxT version as JSON.
- `download-models [--model ID ...] [--cache-dir DIR]` fetches deep-learning
  weights for offline use.

The weights (20 files, 1.8 GB) are not in the release (`bundleModels: false` in
`release.json`). `model.manifest.json` lists every model in qsm-core v0.39.0's
registry at a pinned commit of the Hugging Face repository
`qsmxt/qsm-onnx-weights`, with the registry's SHA-256. The build checks all
hosted cache filenames, sizes and checksums against the pinned Rust registry.

Native QSMxT has no offline switch and its model downloader ignores proxy
environment variables. Before any native processing command, including
QSMART, the wrapper therefore verifies the complete 20-file registry in one local directory.
Missing weights download from pinned URLs into
`~/.cache/neurodesk/qsmbly/models`. This first-use download is 1.8 GB,
including for a classical reconstruction. Later runs verify the cached
files and use no model network requests. Help, version, initialization,
BIDS validation, DICOM conversion, example downloads and `run --dry` need
no weights.

Both `QSMBLY_OFFLINE=1` and `NEURODESK_OFFLINE=1` forbid wrapper downloads.
An incomplete offline cache fails before QSMxT starts. Both native model
environment variables point at the same complete verified directory, so
QSMxT never falls back to its mutable model URLs. Set
`NEURODESK_QSMBLY_MODEL_DIR` to a complete model pack to avoid user-cache
copies. The launcher preserves this override and sets `NEURODESK_OFFLINE`
automatically only for releases that bundle models.

`download-models --model ID` can still fetch individual files. Native compute
requires the complete registry, so use `download-models` without `--model`
before taking the command line offline.

Native example downloads use a commit-pinned mirror on the Neurodesk Hugging
Face dataset. `examples.manifest.json` lists all 23 acquisitions (2.99 GB in
total); only the selected acquisitions download. The build checks their
filenames, sizes and checksums against QSMxT's pinned example registry.
`QSMXT_EXAMPLE_BASE_URL` is always set to this mirror for native execution.
Native QSMxT verifies each archive before unpacking it.

Offline mode disables `example` downloads. `example --list`, command help
and processing local data remain available offline. Prepare example data
while online, then use `run` offline with the complete model cache.

Native `slurm` and `tui` execution are unavailable in both modes. Their
scheduler jobs invoke QSMxT directly and bypass the wrapper's verified model
preflight; the TUI can generate and submit those jobs internally. Their help
remains available. Write scheduler scripts that invoke `qsmbly run` instead.

The wrapper refuses `qsmbly update`, which would replace the pinned binary.

## Validation

`validation/cli-check.mjs --executable PATH` stages the app's example
(`apps/qsmbly/examples.json`) as a BIDS dataset, replays its exported command with the original phase sidecar and compares the χ map with the browser's. The browser
reference is a fingerprint, not the map: mask and support voxel counts,
percentiles, and mean χ in 10-voxel blocks (`validation/measure.mjs`).
WebAssembly SIMD and native code sum in different orders, so the maps are not
bit-identical; `browser-reference.json` records the tolerance and the
agreement observed when it was set.

To record a new reference after the app or qsm-core changes:

```bash
pnpm --filter qsmbly build
node packages/qsmbly/validation/browser-reference.mjs
pnpm --filter @neurodesk/qsmbly build
node packages/qsmbly/validation/cli-check.mjs
```

Recording keeps `tolerance` and `observed`; review the evidence against the new
comparison. `test/node.test.js` ties the browser reference to the exact engine
and core commits in the WASM crate's Cargo files and the measured native release
to `qsmxt.json`. A version label alone does not establish numerical compatibility;
run the exported command and retain the measured agreement before changing a pin.
