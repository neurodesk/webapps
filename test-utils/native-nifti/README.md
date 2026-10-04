# Native NIfTI reader characterization

This package tests the actual SynthSR and SynthSeg readers and volume modules
without their inference models or ONNX Runtime dependencies.

Run both profiles from the repository root:

```sh
cargo test --locked --manifest-path test-utils/native-nifti/Cargo.toml
cargo test --locked --release --manifest-path test-utils/native-nifti/Cargo.toml
```

Generated 2 × 2 × 2 fixtures cover all eight scalar datatypes in both byte orders.
Assertions pin each reader's scaling, precision, channels, geometry and error
priority. Recorded baseline snapshots also compare 82 cases per reader using
exact float bits, dimensions, metadata, errors and complete writer bytes.

SynthSR's infinite offset panics in debug and returns a truncation error in
release. Separate snapshots preserve that existing behavior. SynthSeg uses one
snapshot in both profiles. These tests characterize the readers; they do not
replace the native scientific parity tests.
