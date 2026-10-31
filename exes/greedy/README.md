# Greedy Rust

Rust implementation of the three production Greedy workflows (`-d 3`):
SSD/NMI affine or rigid registration, nonlinear NMI or NCC stationary-velocity, and reslice. Native CLI
plus a `wasm-bindgen` API. The core has two dependencies (`flate2`, and
`rayon` behind the default `parallel` feature) and no unsafe code.

## Offline distributions

The `greedy-native` workflow prepares `greedy-VERSION-linux-x64.tar.gz`,
`greedy-VERSION-windows-x64.zip`, `greedy-VERSION-macos-arm64.pkg` and
`neurodesk-greedy-VERSION.tgz`. Linux targets Ubuntu 22.04 or a compatible newer
glibc system. The Apple installer installs `/usr/local/bin/greedy-rs`; Linux
and Windows archives contain the executable and attribution files. No models
or network access are required at execution time.

For npm installation, see the [package instructions](../../packages/greedy/README.md).
The `.pkg` is signed and notarized only during a release dispatch. Test installers
have `-adhoc` in their filenames and are not uploaded as release assets.

Build and exercise a Linux archive locally:

```bash
python3 scripts/package-greedy.py package linux-x64
```

Run this command from the repository root with Python 3.12 or later. Windows and Apple ARM packages must
be built on their corresponding machines. The packaging script extracts the
archive and checks a generated NIfTI reslice before writing its checksum and
validation report.

An app release (`release.yml`) dispatches `greedy-native` with
`sign_release=true` at its `greedy-vVERSION` tag. The workflow checks that the
tag is the dispatched commit, attaches the packages to that release and updates
the Standalone catalog. Apple
signing uses the existing `APPLEID`, `APPLEIDPASS`, `APPLE_TEAM_ID`, `CSC_LINK`,
`CSC_KEY_PASSWORD`, `CSC_INSTALLER_LINK` and `CSC_INSTALLER_KEY_PASSWORD` secrets.
The workflow attaches artifacts after native and installed npm tests pass.
It does not publish the package to the npm registry.

The [catalog rollout plan](../../docs/architecture/offline-executables.md) records
remaining applications and the required release checks.

## Build and check

```sh
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo build --release -p greedy-rs
```

The C-reference parity case needs the external benchmark and is intentionally
reported as ignored by the default test run. Run it explicitly with:

```sh
GREEDY_BENCH_DIR=/path/to/allineate-benchmark \
  cargo test -p greedy-rs --test workflows nmi_affine_2mm_matches_greedy_within_float_double_spread -- --ignored
```

The whole-head regression gates for issue #623 are also ignored by default: a
masked and an unmasked NMI affine of a defaced 1 mm T1 to ICBM 2009c, and the
masked affine started from the unmasked one (`-ia`) on two T1s where the
identity start collapses. The `whole-head-reference` job of `greedy-native.yml`
runs them on every change; locally, fetch the pinned data and run them by name:

```sh
python3 scripts/fetch_t1_template.py /path/to/greedy-t1-template
GREEDY_T1_TEMPLATE_DIR=/path/to/greedy-t1-template \
  cargo test --release -p greedy-rs --test workflows whole_head -- --ignored
```

Build the threaded browser runtime through the workspace package, which selects
the pinned nightly and shared-memory flags:

```sh
cd ../..
pnpm --filter @neurodesk/greedy build:wasm
```

The generated module lives in the ignored `packages/greedy/wasm` directory.
Browser apps stage that directory unchanged so the Rayon worker and WebAssembly
relative URLs remain valid; the standalone Greedy web release contains it.

## CLI

The flags mirror Greedy; unsupported ones fail with a message.

Running `greedy-rs` without arguments, or with `-h` or `--help`, prints the
available workflows. `greedy-rs --version` prints the workspace version. The
Greedy app manifest owns the release version; `pnpm release` synchronizes it to
the JavaScript package, Cargo workspace, and lockfile.

```sh
greedy-rs -d 3 -a -m SSD -i fixed.nii.gz moving.nii.gz -o aff.mat -ia-image-centers -n 100x50x10
greedy-rs -d 3 -a -dof 6 -m NMI -i fixed.nii.gz moving.nii.gz -o rigid.mat -ia-image-centers
greedy-rs -d 3 -m NMI -i fixed.nii.gz moving.nii.gz -it aff.mat -o warp.nii.gz -sv -n 100x50x10
greedy-rs -d 3 -m NCC 2x2x2 -i fixed.nii.gz moving.nii.gz -it aff.mat -o warp.nii.gz -sv -n 100x70x50
greedy-rs -d 3 -rf fixed.nii.gz -rm moving.nii.gz out.nii.gz -r warp.nii.gz aff.mat
greedy-rs -d 3 -rf fixed.nii.gz -rm mask.nii.gz warped-mask.nii.gz -ri NN -r warp.nii.gz aff.mat
greedy-rs -d 3 -rf fixed.nii.gz -rm ct.nii.gz warped-ct.nii.gz -rb auto -r warp.nii.gz aff.mat
```

- `-V 0` silences the Greedy-style optimizer trace; `-threads N` limits the
  rayon pool (results are identical for any thread count).
- `-m NCC RxRxR` (`-sv` only) is Greedy's neighbourhood cross-correlation over a box of radius R
  voxels, the unweighted `MultiComponentWeightedNCCImageMetric` with its exact gradient. As in
  Greedy, the radius shrinks where a level is too small for the window, and the fixed image is
  downsampled without the mask. Greedy also adds noise of 0.001 interquartile ranges to NCC's
  inputs; greedy-rs does not, so it stays deterministic, and regularises the variances only with
  Greedy's 0.01. On five T1-to-ICBM 2009c registrations (`-n 100x50x0 -gm`) it gave the same
  correlation with the native warped template as Greedy 1.4 to within 0.004.
- `-gm MASK` (affine and `-sv`) is Greedy's fixed-image mask. It must be on the fixed grid. At every pyramid level the mask is smoothed and resampled like an image; with NMI, at the coarse levels the fixed image is divided by it where it is at least 0.5 and zeroed elsewhere (Greedy's masked downsampling), and fixed voxels outside it are excluded from the joint histogram and the gradient. With NCC, only the windows centred inside it count, at a mask value of at least 0.5 on each level. This differs from Greedy, which keeps the mask's weights, scores centres where the mask is 1 and dilates it by the radius for the gradient; at coarse levels Greedy therefore drops boundary voxels that greedy-rs keeps. BISON registers unmasked. Use it with whole-head images, rather than registering two skull-stripped images whose mask boundaries differ (for example, at the brainstem cut-off).
- Affine registration uses 12 degrees of freedom by default. `-dof 6` limits
  the result to rigid-body translation and rotation.
- The affine starts from the physical identity, as Greedy does; `-ia-image-centers`
  starts from aligned image centres. The two are not interchangeable: on a
  whole-head T1 to template pair with `-gm`, the image-centres start falls into a
  degenerate NMI basin (determinant 4) in Greedy and greedy-rs alike (#623).
  `-ia FILE` starts from a matrix as `-o` writes it. The identity start still
  collapses on some subjects (determinants 30 and 2.2 on two of five BISON T1s,
  as in Greedy); starting the masked affine from the unmasked one converged on
  all five:

  ```sh
  greedy-rs -d 3 -a -m NMI -i template.nii.gz t1.nii.gz -o head.mat
  greedy-rs -d 3 -a -m NMI -i template.nii.gz t1.nii.gz -gm template_mask.nii.gz -ia head.mat -o aff.mat
  ```
- Reslicing is linear by default. Use `-ri NN` for masks and label maps.
  Scalar 4-D inputs are resliced volume by volume with one transform chain;
  their number of time points, temporal spacing, and temporal units are kept.
  Encoded volumes stream to an atomic temporary output instead of retaining a
  second complete 4-D copy in memory.
- `-rb VALUE` sets the value outside the moving image field of view. `-rb auto`
  uses the lower of zero and the moving image's finite minimum, which preserves
  the air background of CT images while retaining zero for magnitude images.
- `-jitter SIGMA` (default 0.5, as Greedy) offsets every affine sample by a
  fixed Gaussian draw of that standard deviation in moving voxels; `-jitter 0`
  samples exactly at the mapped voxel centres. `-seed` and `-double` are
  rejected. Images are always f32; geometry, histograms, and reductions are
  f64.
- `--verify-aligned SRC` (reslice) requires the moving image grid to match
  the registration source within 1e-4 mm.
- `-dump-pyramid` (affine) and `-dump-moving` (deformable) write the same
  intermediates as Greedy for stage-by-stage comparison.
- `-metric ... --gradient --pyramid-level L` prints the affine objective and
  its scaled gradient at one level, matching Greedy's `-debug-deriv` output.

## Browser API

`greedy-rs-wasm` exports `register_affine_wasm`, `register_affine_masked_wasm`,
`register_rigid_masked_wasm` (`-dof 6`), `register_nmi_svf_wasm`,
`register_nmi_svf_masked_wasm`, `reslice_affine`, `reslice_affine_options`,
`reslice_warp_affine`, and `reslice_warp_affine_options` over in-memory NIfTI
blobs. The option-bearing
reslicers expose nearest-neighbour interpolation, background fill and SYNcro's
optional preceding pathological-to-primary affine. The browser host must call
its async `initThreadPool` export before registration; the WASM build then uses
the core's Rayon slab loops. It is gzip-free: pass raw `.nii` bytes, and use
browser `CompressionStream` / `DecompressionStream` for `.nii.gz` at the host
boundary. Native builds retain `.nii.gz` support.

## Compatibility with Greedy 1.3

Reference: Greedy 1.3.0-alpha, `-threads 1 -jitter 0`, in `-float` and in the
default double precision, on `allineate-benchmark` (`MNI152_T1_1mm` fixed,
`T1_head` moving). The float-versus-double spread is the acceptance bar; see
`tests/reference/README.md` and `scripts/`.

| Output (1 mm) | greedy-rs vs greedy double | greedy float vs double |
|---|---|---|
| NMI affine `.mat` | max dA 1.4e-5, translation 0.002 mm | 7.2e-4, 0.016 mm |
| SSD affine `.mat` | 0.041, 13.4 mm (0.013, 0.46 mm vs float) | 0.028, 12.95 mm |
| NMI SV warp | RMS 0.71 mm, max 13 mm | RMS 0.82 mm, max 14.6 mm |
| Resliced image | NCC 0.9926 | NCC 0.9912 |

On that 1 mm pair, stage-level agreement is: NIfTI geometry to 3e-7 mm,
pyramid voxels to 5e-7 relative, the SSD and NMI affine objectives and their
analytic gradients to every digit Greedy prints, and the L-BFGS trace matches
Greedy's double build step for step until floating-point divergence. Reslicing
a Greedy warp reproduces Greedy's resliced image to 1e-3 intensity units.

This narrow 1 mm reference is not yet a universal affine-NMI claim. A broader
2026-09-10 sweep over the NiiVue registration images found 19/28 complete
C-double/C-float/Rust triples inside Greedy's own float--double matrix spread.
The remaining meaningful differences are coarse-grid or low-overlap cases
(notably 2 mm template to T1 head, DWI, and fMRI); C's NMI analytic gradient
itself disagrees with its finite-difference check on the DWI case. The saved
reference matrices, logs, and reslices are ignored test artifacts in
`tests/demo-parity-20260910/`; those generated artifacts remain outside this
source import.

SSD affine on these inputs collapses the moving image in Greedy itself (the
linear part goes to zero), so its reference spread is 13 mm; greedy-rs lands
near Greedy's float solution.

## Performance

| Workflow (1 mm) | greedy-rs 14 thr | greedy-rs 1 thr | greedy 1.3 float 14 thr | greedy 1.3 float 1 thr |
|---|---|---|---|---|
| SSD affine | 0.36 s, 226 MB | 2.3 s | 1.3 s, 146 MB | 5.1 s, 145 MB |
| NMI affine | 0.61 s, 281 MB | 3.8 s | 2.8 s, 183 MB | 6.1 s, 159 MB |
| NMI SV | 4.7 s, 660 MB | 22.6 s, 677 MB | 8.3 s, 1055 MB | 41 s, 1030 MB |
| Reslice | 0.64 s, 326 MB | 0.8 s | 1.2 s, 394 MB | 2.0 s, 394 MB |

Results are bit-identical for any thread count. Single-threaded, greedy-rs
is 1.6 to 2.2 times faster than Greedy; the recursive Gaussian runs its
recurrence across whole rows so the y and z passes vectorise, affine
gradients accumulate in voxel space and map to physical parameters once per
evaluation, and NMI streams its samples twice instead of storing them.
Remaining single-thread profile for SV: Gaussian ~35%, scaling-and-squaring
interpolation ~25%.

## Known, deliberate differences

- Greedy's deformable run initializes the identity through an SVD solve and
  starts with ~1e-17 of noise in the velocity field. Its partial-volume NMI
  histogram then holds ~1e-17 of mass in bins next to every sample, and the
  derivative of p log p turns that into a ±3e-4 artefact that dominates the
  true 1e-5 gradient at iteration 0. greedy-rs starts from an exact zero
  field. The effect is inside the float/double spread above.
- Greedy draws its affine jitter and its identity-start perturbation from a
  clock-seeded generator; greedy-rs draws both from fixed seeds, so its runs
  are reproducible but not bit-identical to a jittered Greedy run. Without
  jitter, partial-volume NMI has a spurious maximum at the identity when the
  fixed and moving grids coincide, and the affine stays there.
- The NIfTI reader follows ITK 5.3+: the sform is used when it equals the
  qform, or when it is orthonormal and either the qform is absent, the sform
  is scanner-anatomical, or both agree within 1e-4; otherwise the qform.
  Direction cosines come from the chosen matrix, spacing from `pixdim`.
