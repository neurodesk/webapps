# @neurodesk/dwi2trx

DWI2TRX's diffusion tensor fit, which the web app's tensor worker imports from
here, and a command line that runs it in Node.

## Shared code

The app is TypeScript, run by Vite in the browser and by
`node --experimental-strip-types` in its tests. The command line runs plain
Node. The shared core is therefore plain JavaScript modules, which both import
without a build step:

| Module | Content |
| --- | --- |
| `src/gradients.js` | FSL bval/bvec parsing and validation, the b0 index |
| `src/tensor.js` | The fit: b0 extraction, `niimath --dtifit` argv, map names, MindGrab options |
| `src/node.js` | The command line's file handling, MindGrab on the CPU |

`src/tensor.js` takes a `run(args, { inputs, outputs })` function instead of a
niimath module. The app passes one that drives its cached module
(`apps/dwi2trx/src/dwi2trx/dtifit.ts`). The command line passes `runNiimath`
from `@neurodesk/runtime-support/node/niimath`. Both load the same vendored
dtifit-enabled build, `apps/dwi2trx/vendor/niimath`.

## Command line

`dwi2trx` runs the web app's `fit` operation: a MindGrab brain mask of the
first b0 volume, then `niimath --dtifit` inside it. It needs no browser, GPU or
network.

Tractography is not included. The app tracks streamlines with WGSL compute
shaders from `@dipy/gpu-streamlines`, which need WebGPU with the `subgroups`
feature. Node has no such runtime. Track in the web app, or from the written
maps with a native tool such as DIPY or MRtrix3.

### Install

Download the release for your platform from the DWI2TRX app's Standalone
dialog: Linux x64, Windows x64 or macOS on Apple silicon. Each contains a
private Node.js runtime.

On Linux, extract the archive and keep the directory intact:

```bash
tar -xzf dwi2trx-VERSION-linux-x64.tar.gz
./dwi2trx-VERSION-linux-x64/dwi2trx self-check
```

On Windows, use `Expand-Archive` and `dwi2trx.exe`.

On macOS, the release is an installer package signed with a Developer ID and
notarized by Apple. It installs the command line in
`/usr/local/lib/neurodesk/dwi2trx` and the `dwi2trx` command in
`/usr/local/bin`:

```bash
sudo installer -pkg dwi2trx-VERSION-macos-arm64.pkg -target /
dwi2trx self-check
```

To uninstall, delete `/usr/local/lib/neurodesk/dwi2trx` and
`/usr/local/bin/dwi2trx`, then run `sudo pkgutil --forget org.neurodesk.dwi2trx`.

### Commands

```bash
dwi2trx dwi.nii.gz dwi.bval dwi.bvec results
dwi2trx dwi.nii.gz dwi.bval dwi.bvec results --mask brain_mask.nii.gz
dwi2trx dwi.nii.gz dwi.bval dwi.bvec results --no-mask
dwi2trx self-check
```

By default the brain mask is MindGrab's, as in the web app. The command line
runs MindGrab's CPU modules through `@neurodesk/runtime-support/node/mindgrab`,
where the web app uses WebGPU. On the example DWI this took 50 to 100 s and a
2.4 GB peak resident set on an 8-core Linux host. If MindGrab fails, the fit
runs unmasked and says why, as the web app does. `--mask FILE` uses your own
mask instead and must lie on the diffusion image's voxel grid. `--no-mask` fits
every voxel. These are the app's `mask` automation input and its fallback.

The bval and bvec files are FSL text files with one entry per volume. They are
validated as in the web app, and their count must equal the image's volumes.
Input is NIfTI. Convert DICOM with dcm2niix first, or use the web app, which
converts it in the browser. The output directory must be new or empty.
Standard output lists the written files. Standard error gets progress and one
JSON line with the settings that produced the maps: the mask source, the
MindGrab version and backend, and the niimath build.

`self-check` fits a synthetic single-tensor phantom and fails unless its FA is
the analytic 0.6030. `download-models` exists for the shared packager and does
nothing: MindGrab's weights are compiled into its WebAssembly.

### Outputs

Every map `niimath --dtifit` writes, named after the diffusion image:

| File | Content |
| --- | --- |
| `<dwi>_FA.nii.gz` | Fractional anisotropy |
| `<dwi>_MD.nii.gz` | Mean diffusivity |
| `<dwi>_L1.nii.gz`, `_L2`, `_L3` | Eigenvalues |
| `<dwi>_V1.nii.gz`, `_V2`, `_V3` | Eigenvectors, three volumes each |
| `<dwi>_S0.nii.gz` | Fitted non-diffusion-weighted signal |
| `<dwi>_MO.nii.gz` | Mode of anisotropy |
| `<dwi>_tensor.nii.gz` | The six tensor elements |
| `<dwi>_mask.nii.gz` | The MindGrab brain mask, when one was computed |

`<dwi>_FA.nii.gz` and `<dwi>_V1.nii.gz` are the app's "Save maps" downloads.
The app's `fit` automation operation returns all eleven maps under the same
names.

### Accuracy

`validation/cli-check.mjs` is the release gate. It fits the web app's pinned
example (`dwi-gradients`, 72x72x39, 21 volumes, b = 2500) with the command line
and compares every map with `validation/dwi-gradients-reference.json`.

That file holds two things:

- `mask`: the MindGrab mask the command line computes from the example's b0 on
  the CPU. The CPU modules reproduce MindGrab's browser CPU backend byte for
  byte (`packages/runtime-support/validation/reference.json`, checked on Linux,
  Windows and macOS by `node-drivers.yml`).
- `browser`: the eleven maps the web app downloaded when given that mask through
  its `mask` automation input. `apps/dwi2trx/e2e/reference.spec.js` recorded
  them through the built app, its tensor worker and the vendored niimath, in
  Chromium. Giving the app the mask isolates the fit from MindGrab's WebGPU
  backend, whose output is not byte-identical to the CPU backend's.

The check requires the command line's mask voxels to equal the recorded mask's.
For every map, it requires the stored header geometry, header bytes, voxel
hash, non-finite count, non-zero count, value range, mean and standard
deviation to equal the web app's. FA must lie in [0, 1]. A second run with
`--mask` and the written mask must reproduce the web app's voxels in every map.
The command line and the web app run one WebAssembly build, so no tolerance is
needed.

```bash
node packages/dwi2trx/validation/cli-check.mjs
node packages/dwi2trx/validation/cli-check.mjs --executable path/to/dwi2trx
DWI2TRX_BROWSER_REFERENCE=write pnpm --filter dwi2trx exec playwright test e2e/reference.spec.js
```

Rerecord the reference when the vendored niimath or the MindGrab pin changes.
The `web-app-reference` job in `dwi2trx-native.yml` reruns the browser
recording with `DWI2TRX_BROWSER_REFERENCE=check`.

Not checked: how far the CPU mask is from the web app's WebGPU mask on the
same b0. GitHub's Linux runners have no WebGPU adapter for MindGrab.
