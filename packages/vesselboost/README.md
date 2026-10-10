# VesselBoost

Shared explicit-state step pipeline for vessel segmentation, optional downsampling,
N4 bias correction, bilateral/NLM denoising and BET/SynthStrip brain extraction.
The browser worker and portable command line inject their runtimes into this package.

## Command line

Download a complete portable archive from the app's Standalone action, extract it,
and run locally. The macOS installer provides `vesselboost` on PATH.

```sh
vesselboost self-check
vesselboost input.nii.gz results --no-bias-correction --threads 4
vesselboost input.nii.gz results --downsample 2 --denoise bilateral --brain-extraction bet
```

`--help` lists every scientific option. Defaults match the app's automation contract:
manual model, original resolution, N4 enabled, no denoising, overlap 0, threshold 0.1,
minimum component size 10, no brain extraction and BET fractional intensity 0.5.
A single 3D or singleton 4D NIfTI is accepted. DICOM import and manual mask editing
use the browser. The output directory must be empty or new.

Outputs match the browser's stage downloads: `segmentation.nii`, and when requested,
`downsample.nii`, `n4.nii`, `nlm.nii`, `bet.nii` and `brain-mask.nii`. Masks retain the
analysis grid, which is the downsampled grid when downsampling is selected.

Complete portable archives contain all four pinned VesselBoost models, SynthStrip,
a private Node runtime and the required preprocessing WASM. They run without network
or a populated home cache. The source CLI can prepare a model directory with
`vesselboost download-models --cache-dir PATH`. Use that directory with `--cache-dir PATH`
and `--offline`, or set `NEURODESK_VESSELBOOST_MODEL_DIR` and `NEURODESK_OFFLINE=1`.
Selected models are SHA-256 checked before processing and again when loaded.
The CLI writes only requested outputs; native ONNX Runtime telemetry is disabled
before import for both CLI and direct Node API use.

## Required preprocessing artifact

`preprocessing/` is a committed build of the app's Rust preprocessing source.
`pnpm --filter @neurodesk/vesselboost build` verifies every artifact checksum;
`build:wasm` rebuilds using Rust 1.98.0, wasm-pack 0.13.1, wasm-bindgen 0.2.114,
locked QSM.rs commit `3aa02ca2ba77b4cc069366a7db9847d6b0c9d19d` and no wasm-opt.
Native CI rebuilds and compares committed bytes. Both browser and Node must
initialize this artifact successfully, including workflows that skip optional steps.

## Validation and licensing

`validation/cli-check.mjs --executable PATH` runs the actual production browser app
and portable CLI on the pinned Lausanne TOF crop, with and without optional Rust
preprocessing. It retains the independent upstream PyTorch mask's Dice >= 0.99 gate;
optional preprocessing downloads must match browser bytes exactly. See
`apps/vesselboost/test/fixtures/upstream-reference/README.md` for scientific provenance.

The imported VesselBoost source and model weights retain **NOASSERTION** status.
This package is **UNLICENSED**, not newly MIT licensed. `NOTICE` and preprocessing
license files record separately licensed QSM.rs, Rust, components, ORT and SynthStrip.
