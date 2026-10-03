# fida

A Rust port of FID-A (Jamie Near et al., BSD-3-Clause;
[CIC-methods/FID-A](https://github.com/CIC-methods/FID-A) at `1eaa2075`) for
single-voxel MR spectroscopy: the vendor readers, the processing functions and
the automatic pipelines. `apps/lcmodel` runs it in the browser through
`packages/lcmodel`, before LCModel (`exes/lcmodel`).

* `src/spectra.rs`: the FID-A structure (`fids` column-major over `sz`, `dims`,
  `ppm`, `t`, header fields, `flags`).
* `src/io/`: `twix` (Siemens VB/VD/VE/XA), `ge` (P-files), `rda`,
  `dicom_siemens`, `sdat` (Philips SPAR/SDAT), `niimrs` (NIfTI-MRS), `bruker`,
  `lcmraw` and `lcm` (LCModel .RAW in and out), and `detect`, which sorts a set
  of dropped files and pairs each spectrum with its water reference. Readers take
  bytes, never paths, so they run in WebAssembly. `geometry` (not in FID-A)
  reads the voxel position, size and orientation from twix, Siemens DICOM, RDA,
  SPAR and NIfTI-MRS headers as a NIfTI-MRS-style RAS affine, with spec2nii's
  conventions; `tests/geometry.rs` compares it with spec2nii on Osprey's
  examples (`OSPREY_EXAMPLES`).
* `src/ops/`: the FID-A `op_*` functions (coil combination, averaging, removal
  of bad averages, spectral registration in time and frequency domain, ISIS and
  MEGA subspectra, shifts, phasing, referencing, HSVD water removal, Klose
  eddy-current correction, SNR and linewidth) and `pipeline`: deterministic
  `run_pressproc_auto` (with `run_pressproc_GEauto`'s phasing as an option),
  `run_specialproc_auto` and `run_megapressproc_auto`, with a JSON report, progress and cancellation.

```bash
cargo test --release                                 # unit and synthetic-signal tests
python3 validation/fetch_reference.py $TMPDIR/fida-reference   # pinned FID-A references
FIDA_TEST_DATA=$TMPDIR/fida-reference FIDA_REQUIRE_REFERENCE=1 cargo test --release
cargo build --release --target wasm32-unknown-unknown --lib
```

Each reader and op is compared with FID-A itself running in GNU Octave on
FID-A's example data (GE PRESS, Siemens SPECIAL/MEGA-PRESS, Bruker) and on
converted test files. The readers match FID-A exactly; the pipelines agree to
within 10^-5 Hz in drift estimates and 10^-8 relative in the final spectra.
`validation/README.md` gives the Octave set-up, the scripts that regenerate the
references and the numbers per file and per op, and the FID-A quirks the port
keeps (conjugation and ppm-axis sign per reader, randomised registration
windows replaced by FID-A's centre values).
