# @neurodesk/easy-mp2rage

The Easy MP2RAGE WebAssembly core, its NIfTI reader and writer, and a command
line. The web app in `apps/easy-mp2rage` stages `src/nifti.js`,
`src/outputs.js` and `wasm/` from this package, so the browser and the command
line run the same binary and write the same files.

## Command line

`easy-mp2rage` runs the web app's two batch operations on the CPU with Node. It
needs no browser, GPU or network.

### Install

Download the release for your platform from the web app's Standalone dialog:
Linux x64, Windows x64 or macOS on Apple silicon. Each contains a private
Node.js runtime.

On Linux, extract the archive and keep the directory intact:

```bash
tar -xzf easy-mp2rage-VERSION-linux-x64.tar.gz
./easy-mp2rage-VERSION-linux-x64/easy-mp2rage self-check
```

On Windows, use `Expand-Archive` and `easy-mp2rage.exe`.

On macOS, the release is an installer package signed with a Developer ID and
notarized by Apple. It installs Easy MP2RAGE in
`/usr/local/lib/neurodesk/easy-mp2rage` and the `easy-mp2rage` command in
`/usr/local/bin`:

```bash
sudo installer -pkg easy-mp2rage-VERSION-macos-arm64.pkg -target /
easy-mp2rage self-check
```

To uninstall, delete `/usr/local/lib/neurodesk/easy-mp2rage` and
`/usr/local/bin/easy-mp2rage`, then run
`sudo pkgutil --forget org.neurodesk.easy-mp2rage`.

From a checkout of this repository, the committed WebAssembly core in `wasm/`
runs as is:

```bash
node packages/easy-mp2rage/bin/easy-mp2rage.js --help
```

After changing `apps/easy-mp2rage/crates/mp2rage-core` or `mp2rage-wasm`,
rebuild it and commit `wasm/`. The build is reproducible byte for byte with
Rust 1.98.0 and its `wasm32-unknown-unknown` target, wasm-pack 0.13.1 and binaryen
`version_117` `wasm-opt` on `PATH`; the script refuses other versions. The
`wasm-source` job in `easy-mp2rage-native.yml` rebuilds it and fails when any
committed file differs:

```bash
pnpm --filter @neurodesk/easy-mp2rage build:wasm
bash packages/easy-mp2rage/scripts/build-wasm.sh --check
```

### Commands

```bash
# B1-corrected T1 map from a measured B1 map
easy-mp2rage correct --uni UNI.nii.gz --inv2 INV2.nii.gz \
  --b1 B1.nii.gz --b1-type tfl --reference-angle 80 \
  --mp2rage 5.0,0.7,2.5,4,5,64,128,0.0067,0.96 results

# B1-corrected T1 map from SA2RAGE
easy-mp2rage correct --uni UNI.nii.gz --inv2 INV2.nii.gz \
  --sa2rage SA2RAGE.nii.gz --sa2rage-params 2.4,0.15,1.5,6,6,24,24,0.005,1.5 \
  --mp2rage 4.3,0.84,2.37,5,6,64,128,0.007,0.96 results

# Denoised UNI (O'Brien robust combination)
easy-mp2rage denoise --uni UNI.nii.gz --inv1 INV1.nii.gz --inv2 INV2.nii.gz results

easy-mp2rage self-check
```

`download-models` exists for the shared packager and does nothing: the
WebAssembly core is part of the installation and no model files are needed.

The options are the parameters of the `correct` and `denoise` operations in
`apps/easy-mp2rage/automation.json`:

| Option | Automation parameter | Meaning |
| --- | --- | --- |
| `--mp2rage` | `mp2rage` | TR, TI1, TI2 (s), FA1, FA2 (degrees), NZ1, NZ2, TRFLASH (s), inversion efficiency |
| `--sa2rage-params` | `sa2rage` | SA2RAGE TR, TD1, TD2 (s), FA1, FA2 (degrees), NZ1, NZ2, TRFLASH (s), average T1 (s) |
| `--b1-type` | `b1Type` | B1 map units: `tfl` (flip degrees x 10), `percent` or `relative` |
| `--reference-angle` | `referenceAngle` | Reference flip angle of a tfl map, default 80 |
| `--extend-fov` | `extendFov` | Extend B1 coverage beyond the measured field of view |
| `--fallback-uncorrected` | `fallbackUncorrected` | Fill non-converged voxels with uncorrected values |
| `--regularization` | `regularization` | Robust-combination strength, default 6 |

`--sa2rage` names the SA2RAGE image. Its acquisition values go in
`--sa2rage-params`, because the automation contract uses the name `sa2rage` for
both. Without `--inv2`, `correct` masks with UNI, as the web app does.

INV1 and INV2 are combined with UNI voxel for voxel, so both commands refuse them
unless they share UNI's voxel grid: the same dimensions and an affine that
differs by at most 1e-5 in each coefficient (the shared `sameVoxelGrid` check,
which allows float32 header rounding). The B1 map and SA2RAGE image may be on
any grid; they are resampled to UNI through their affines.

Inputs are NIfTI. Convert DICOM with dcm2niix first, or use the web app, which
also reads acquisition values from DICOM headers and BIDS sidecars and runs BIDS
batches. The output directory must be new or empty.

### Outputs

The files have the web app's download names:

| Command | Files |
| --- | --- |
| `correct` with `--b1` | `T1map.nii.gz` (ms), `B1map.nii.gz`, `T1map_uncorrected.nii.gz`, `UNI_b1corrected.nii.gz`, `parameters.json` |
| `correct` with `--sa2rage` | as above, with `B1map_from_SA2RAGE.nii.gz` |
| `denoise` | `UNI_denoised.nii.gz`, `parameters.json` |

`parameters.json` records every setting that changes a result: the MP2RAGE and
SA2RAGE acquisition values, the B1 map units, the reference angle of a tfl map,
`extend_fov`, `fallback_uncorrected`, `mask_source` (`INV2`, or `UNI` without
`--inv2`) and the denoising `regularization`. The web app writes the same record.

### Accuracy

`validation/cli-check.mjs` is the release gate. Its references come from the
Python pipeline in `apps/easy-mp2rage/mp2rage_t1`, not from the WASM core the
command line runs. `tools/gen_cli_golden.py` runs that pipeline on the golden
phantom once per command-line option (SA2RAGE and tfl B1 sources, reference
angles 80, 60 and 40, `--extend-fov`, `--fallback-uncorrected`) and keeps every
file it writes in `tools/golden/cli/`. For each case the check requires:

- every output file on the phantom's 24x20x18 grid and affine, with one value
  per voxel;
- T1 maps within 0.1 ms (the tolerance of `web/test/e2e_node.mjs`), B1 maps
  within 1e-4 and the B1-corrected UNI within 1e-2 of the Python files;
- each option's Python output to differ from the run without it, so a command
  line that ignores the option fails;
- `parameters.json` to record the options;
- every output to equal the web worker's WASM calls voxel for voxel.

The denoised UNI must equal the Python robust combination exactly at
regularization 6 and 2. The pinned 7 T example, with default and non-default
options, must equal the web worker's WASM calls voxel for voxel on UNI's grid.
Measured worst differences from Python are 2.4e-4 ms (T1) and 1.2e-7 (B1).

The phantom has no input without INV2: the Python pipeline then masks
`|UNI - median(UNI)|`, while the web app and the command line mask UNI itself,
so the two disagree there.

```bash
node packages/easy-mp2rage/validation/cli-check.mjs
node packages/easy-mp2rage/validation/cli-check.mjs --executable path/to/easy-mp2rage
```

### Other command lines

`apps/easy-mp2rage` also has the Python reference CLI (`easy-mp2rage-t1map`),
which reads DICOM and sidecars, and a native Rust CLI (`crates/mp2rage-cli`).
The Rust CLI has no denoising or DICOM input and is not released. This Node
command line is the released one, because it runs the exact binary of the web
app and packages the same way as the other Neurodesk command lines.
