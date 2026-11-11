# synthseg

Self-contained native SynthSeg 2.0 executable. Reproduces FreeSurfer 8.1.0
`mri_synthseg --i IN --o OUT` with no Python, TensorFlow, FreeSurfer or model
files at run time: the checksum-pinned ONNX graph is embedded and ONNX Runtime
is statically linked. Apple Silicon macOS is the supported release; the source
builds anywhere the `ort` crate does.

```sh
synthseg --i T1_head.nii.gz --o seg.nii.gz      # default: flip averaging + topology cleanup
synthseg T1_head.nii.gz --fast                   # writes T1_head_synthseg.nii.gz, no flip/topology
synthseg T1_head.nii.gz --vol T1_head_vol.csv    # also writes mri_synthseg --vol soft volumes (mm³)
synthseg T1_head.nii.gz --tissues                # also writes T1_head_synthseg_gm/_wm/_csf.nii.gz
synthseg ct.nii.gz out.nii.gz --ct               # clip Hounsfield units to [0, 80]
synthseg --self-check
```

Options: `--device cpu|metal` (default `metal` on macOS), `--threads N` (default:
`SLURM_CPUS_PER_TASK`, else all cores), `--force`, `--quiet`. Output is an int32
label map on the 1 mm grid, like the Python tool; a JSON sidecar records
settings, model checksum, geometry and timings.

| Device | Runs | M4 Pro, 192×224×160, default / `--fast`, peak RSS |
| --- | --- | --- |
| `metal` | Native Metal port of the synthsr blocked FP32 Conv3D executor ([src/metal.rs](src/metal.rs)) | 6.6 s / 3.6 s, 3.4 GB |
| `cpu` | ONNX Runtime CPU provider, all cores | 14.6 s / 7.4 s, 14 GB |

`mri_synthseg` on the same volumes: 3:38 single-threaded, 27 s with 10 threads.
Blur, flip averaging, connected components and argmax run on the CPU for every
device ([src/post.rs](src/post.rs)); the GPU runs only the U-Net. The CPU path
will swap on a 16 GB machine (ORT arena); first fix would be arena options or
spatial tiling.

## Tissue probability maps

`--tissues` also writes `OUTPUT_gm`, `OUTPUT_wm` and `OUTPUT_csf`, with the
label map's extension and compression: float32 NIfTI with the label map's
header geometry. mri_synthseg has no equivalent; its `--post` writes all 33
posteriors. Each voxel holds the sum of the normalised posteriors of one group
of structures (`post::GM_LABELS`, `WM_LABELS`, `CSF_LABELS`), from the same
postprocessed posteriors as the labels and the `--vol` table. The groups follow
FreeSurfer's convention:

| Map | FreeSurfer labels |
| --- | --- |
| GM | cerebral cortex 3/42, cerebellar cortex 8/47, and the structures in FreeSurfer's SubCortGrayVol: thalamus 10/49, caudate 11/50, putamen 12/51, pallidum 13/52, hippocampus 17/53, amygdala 18/54, accumbens 26/58, ventral DC 28/60 |
| WM | cerebral white matter 2/41, cerebellar white matter 7/46, brainstem 16 |
| CSF | lateral ventricles 4/43, inferior lateral ventricles 5/44, 3rd ventricle 14, 4th ventricle 15, CSF 24 |

Ventral DC is GM because SubCortGrayVol counts it, although it contains some
white matter. The brainstem is WM because it is mostly white matter;
FreeSurfer puts it in no tissue total. The three groups cover every label
except background, so GM + WM + CSF = 1 − P(background). These are aggregated
anatomical class probabilities, not the output of a tissue-segmentation model.
The grid is the label grid: the input grid when each voxel side is 0.95 to
1.05 mm, otherwise the resampled 1 mm grid. In `--fast` mode the 0.2 posterior
threshold makes the maps sparse; the default mode keeps lower values.

The maps change neither the labels nor the volumes, and the label path writes
the same bytes with and without `--tissues`. No FreeSurfer golden exists for
them (`mri_synthseg --post` goldens are future work), so the tests hold them to
their own label map: same header geometry, values in [0, 1], a sum of at most
1, and per-tissue totals equal to the `--vol` table's grouped soft volumes.

Not supported: `--robust`, `--parc`, `--qc`, `--v1`, `--photo`, `--keepgeom`,
`--crop`, `--autocrop`, `--post`, `--resample`, folder input, CUDA.

## Install (macOS)

Download `synthseg-VERSION-macos-arm64.pkg` and open it. The package is signed
with a Developer ID, notarized and stapled; it installs `/usr/local/bin/synthseg`.
Requires macOS 13.4 or later on Apple Silicon.

## Build

```sh
make check-model   # fetches the revision-pinned ONNX from Hugging Face into models/, verifies SHA-256
make build         # target/release/synthseg (build.rs re-verifies the model before embedding)
make test          # small fixture (test/fixtures), both modes, every device whose probe succeeds
make lint fmt
```

Requires current stable Rust. The first build downloads pyke's static ONNX
Runtime binaries for the host target.

Assets live in the Hugging Face dataset `neurodeskorg/webapps` under `synthseg/`
(`models/synthseg-2.0.onnx`, the upstream `synthseg_2.0.h5`, validation inputs
and goldens), pinned by an immutable Hugging Face commit in the `revision` field of
`packages/synthseg/model.manifest.json` and the repo-root
`models/synthseg.manifest.json` (registry copy).
`scripts/repoint_model_manifest.sh COMMIT` pins both to a commit. `make export` rebuilds the ONNX and the shared executor graph
index `packages/synthseg/src/gpu-model.json` from a FreeSurfer checkpoint
(python3 with h5py and onnx; no TensorFlow).

## Validation

The oracle is FreeSurfer 8.1.0 `mri_synthseg`. `make test-real` fetches
`T1_head.nii.gz` (1 mm) and `T1_head_2mm.nii.gz` (2 mm) plus their four
goldens into `$SYNTHSEG_REFERENCE_DIR` (default `~/src/synthseg-references`)
and runs both modes on every device. Gates ([tests/parity.rs](tests/parity.rs)):
identical geometry, header codes/units/quaternion equal, mismatch fraction
≤ 5e-6 on the fixture and ≤ 2e-6 on the real volumes (observed: 0–1 voxel of
5.6 M, fp32 accumulation order). Tighten, never loosen. The last run is in
[validation/report.json](validation/report.json). `make references` regenerates
goldens and the Keras preprocessing dump with a local FreeSurfer install;
`make test-keras` checks `volume.rs` against that dump (1e-5).

Engineering parity on named hardware, not clinical validation.

## Numerics, verified and load-bearing

- Preprocessing ([src/volume.rs](src/volume.rs)) runs in f64, matching NumPy;
  only the final model input is cast to f32. Percentiles use
  `select_nth_unstable` plus NumPy's two-form `_lerp`, so `robust_min/max`
  equal `np.percentile` bit for bit. The `(start + step) - start` arithmetic
  in `resample_1mm` reproduces `np.arange` rounding on purpose.
- The sigma-0.5 posterior blur runs in `--fast` too; only flip averaging and
  topology cleanup are skipped there.
- ONNX `Concat` skip connections are the conv outputs before BatchNorm.
- Connected components are 6-connected (`scipy.ndimage.label` default).
- `post::LABELS` (33) is `np.unique` of the 55-entry
  `synthseg_segmentation_labels_2.0.npy`; `FLIP` and `TOPOLOGY` come from
  `get_flip_indices()` and `synthseg_topological_classes_2.0.npy[unique_idx]`,
  verified by numpy recomputation.
- Metal pads conv output channels to a multiple of 4 (33 → 36); Softmax reads
  only the logical 33. `--features metal-f16` changed 188 voxels for no
  speedup and stays off.
- Output header mirrors nibabel: input `qform_code`/`sform_code`/`xyzt_units`
  carried through; a resampled input gets codes (0, 2); units 0 becomes mm; a
  qform-only input gets `sform_code` 1; the quaternion is always written; both
  codes 0 uses nibabel's fallback affine.
- ORT output is NCDHW; Metal's voxel-major output is transposed to
  channel-major on readback, so `main.rs` sees one layout.
- Input hardening: `vox_offset` validated, gzip expansion capped at 2 GB,
  256 M voxel×channel cap on read and 64 M on the padded 1 mm grid (saturating, so
  they also trip on wasm32), i16 dim guard, non-finite `scl_slope` treated as unscaled.
- Output and sidecar are staged to sibling temp files and published sidecar
  first, so a published label map always has its JSON; neither clobbers
  without `--force`.

## Traps

- `build.rs` requires `models/synthseg-2.0.onnx` and checks it against the
  manifest; a stale `.onnx` fails the build rather than loading silently.
- `make macos-pkg` needs an interactive keychain prompt for the Installer
  identity; it cannot run unattended.
- `scripts/keras_reference.py` runs under `fspython`, on `PATH` only after
  `. $FREESURFER_HOME/SetUpFreeSurfer.sh`.

## Release macOS locally

```sh
make macos-notary-profile APPLE_ID='you@example.com' TEAM_ID='ABCDE12345'   # once
EXPECTED_TEAM_ID=ABCDE12345 make macos-release VERSION=0.1.20260910
```

Identities default to the Developer ID certificates in the Keychain;
`NOTARY_PROFILE` defaults to `synthseg-notary` (pass `NOTARY_PROFILE=...` to
reuse an existing profile). `macos-release` checks the profile, runs `test` and
`test-real`, signs, builds the `.pkg`, notarizes, staples and verifies;
`make macos-pkg-adhoc` writes an unsigned package for local testing.

## Citation

Billot B, Greve DN, Puonti O, et al. (2023). SynthSeg: Segmentation of brain
MRI scans of any contrast and resolution without retraining. Medical Image
Analysis 86:102789. https://doi.org/10.1016/j.media.2023.102789

Apache-2.0. See LICENSE, NOTICE and THIRD_PARTY_NOTICES.md.

## Hosted CI validation scope

The standard GitHub `macos-latest` runner has [3 M1 CPU cores and 7 GB RAM](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).
The benchmark inputs pad to 192×224×160. The current FP32 GPU graph allocates
5,543,301,120 bytes of activation buffers, and each CPU posterior copy needs
another 908,328,960 bytes. The default flip pass retains the first posterior
copy while running the second pass. Those allocations and the operating system
exceed the hosted runner's practical memory budget.

Hosted verification and signing jobs therefore set `SYNTHSEG_REAL_DEVICES=cpu`
for the two full-volume benchmarks in both modes. `make test` still runs its
small fixture on CPU and every available Metal device. The validation report
lists available and selected devices, saves each completed case, and records
inference failures before failing the job. CPU-only reports do not establish
full-volume Metal parity.

The first hosted full-volume run passed its four CPU cases, then failed with
`Metal inference failed: Error`. Its 632-second duration includes the CPU
cases. The captured status does not distinguish memory pressure from a command
buffer timeout. No kernel arithmetic or command scheduling was changed in
response to that failure.

Local `make test-real` continues to test all available devices. Run
`SYNTHSEG_REAL_DEVICES=cpu,metal make test-real` on an Apple silicon machine
with sufficient memory to require both backends. Unknown, duplicate, empty,
or unavailable device selections fail. Full-volume Metal remains unverified
by the hosted release job; the previously committed M4 Pro results are separate
hardware validation evidence.
