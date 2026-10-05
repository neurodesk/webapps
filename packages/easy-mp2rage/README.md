# @neurodesk/easy-mp2rage

The Easy MP2RAGE WebAssembly core, its NIfTI reader and writer, and a command
line. The web app in `apps/easy-mp2rage` stages `src/nifti.js`,
`src/outputs.js` and `wasm/` from this package, so the browser and the command
line run the same binary and write the same files.

## Command line

`easy-mp2rage` runs the web app's two batch operations on the CPU with Node. It
needs no browser, GPU or network.

### Install

Download the archive for your platform from the Standalone dialog of the web
app, or from the `easy-mp2rage-vVERSION` GitHub release. Extract it and keep the
directory intact. The archive bundles its own Node runtime.

From a checkout of this repository, build the WebAssembly core first. This
needs Rust with the `wasm32-unknown-unknown` target and `wasm-pack`:

```bash
pnpm --filter @neurodesk/easy-mp2rage build
node packages/easy-mp2rage/bin/easy-mp2rage.js --help
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

### Accuracy

`validation/cli-check.mjs` is the release gate. It runs a command line on the
Python golden phantom, where the SA2RAGE and tfl B1 T1 maps must be within
0.1 ms of `tools/golden` (the tolerance of `web/test/e2e_node.mjs`) and the
denoised UNI must match exactly. It then runs the web app's pinned 7 T example
and requires every output to equal the web worker's WASM calls voxel for voxel.

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
