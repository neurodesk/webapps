# @neurodesk/n4

ANTs N4BiasFieldCorrection compiled to WebAssembly, for the `n4` web app and its command line, with the DWI procedure of MRtrix `dwibiascorrect ants`.
It is a separate module from `@neurodesk/registration`, at the same pinned ANTs commit and ITK-Wasm toolchain, so the SYNcro and ANTs kernels do not change.

## Use

```js
import { createN4, rescaleBias, divideVolumes } from '@neurodesk/n4';
import createModule from '@neurodesk/n4/module';

const n4 = await createN4({ createModule, wasmBinary });
const { corrected, bias } = await n4.correct({ image: meanB0Nifti, weight: maskNifti });
```

`correct` runs `N4BiasFieldCorrection -d 3 -i IN -w WEIGHT -o [CORRECTED,BIAS] -s 4 -b [100,3] -c [1000,0.0]`, the `dwibiascorrect ants` defaults, and returns NIfTI bytes.
For a DWI series, `rescaleBias` keeps the brain integral as `dwibiascorrect` does, and `divideVolumes` corrects every volume.
Run it in a worker: N4 is synchronous.

## EPI-reference profile (SyN-SDC foundation)

The independent EPI-reference builder uses niworkflows 1.15.3's convergence schedule
`50x50x50x50x50` with tolerance `1e-7` and shrink factor 4, without a weight image
or the MRtrix B-spline override. It requests a bias output as well as the corrected
image to preserve this runtime's result contract:

```js
import { createN4, epiReferenceArguments } from '@neurodesk/n4';
const n4 = await createN4({ createModule, wasmBinary, buildArguments: epiReferenceArguments });
const { corrected, bias } = await n4.correct({ image: clippedMeanB0Nifti });
```

The default `createN4` profile is unchanged. Both profiles use the same committed
WASM bytes. A Node test executes the EPI-reference argv on that real module and
checks the corrected-image/bias product against its input. This is entry-point
wiring for #462; the complete SyN-SDC native replay and grid/precision gates remain
pending. It does not establish full-pipeline parity.

## Parity

On the mean b0 of the ds005134 sub-01 example slab, weighted by the app's default MindGrab mask (45 965 voxels), the module's bias field and corrected image equal native ANTs 2.6.5 `N4BiasFieldCorrection` (Neurodesk container `ants_2.6.5_20261012`, one thread, dwibiascorrect's options) byte for byte. It takes about 3 s in Node.
The reference is pinned on Hugging Face (`n4/validation/ds005134-sub-01-slab/`, its README gives every command) by `validation/reference.json`; `test/native-reference.test.js` checks the exact equality in the `dwi-native` workflow:

```sh
export $(node validation/fetch-reference.mjs /var/tmp/n4-reference)
N4_REQUIRE_REFERENCE=1 node --test test/*.test.js
```

An earlier hand check with an FSL `bet -f 0.3` mask (44 521 voxels) was also exact.

## Command line

`bin/n4.js` runs the web app's correction on a NIfTI image with the committed module and writes the app's downloads: the corrected image, the bias field and the brain mask, and the `.bval`, `.bvec` and sidecar when the input has them.

```bash
n4 sub-01_dwi.nii.gz results
n4 T1w.nii.gz results --mask T1w_brain_mask.nii.gz
n4 self-check
```

A 3D image is corrected by N4 directly. For a series, the field is fitted to the mean of the b0 volumes (b < 50 s/mm², or every volume without a `.bval`), then `rescaleBias` and `divideVolumes` correct every volume, as `dwibiascorrect ants` does.
The fit is weighted by a MindGrab brain mask (model `mindgrab`) of that mean b0 or image, from MindGrab's CPU modules through `@neurodesk/node-drivers/mindgrab`. A run needs about 2.6 GB of memory for MindGrab. `--mask FILE` gives a mask on the image grid instead.
The `.bval` (or `.bvals`), `.bvec` (or `.bvecs`) and `.json` beside the image with the same name are paired as the app pairs a dropped selection. For a series, a sole gradient file that no other image in the directory owns, such as FSL's `bvals` and `bvecs`, is paired too; several such files are refused. `--bval`, `--bvec` and `--json` name other files. A sidecar named with `--json` must hold a JSON object.
The output directory must be new or empty.
The mean b0, the output names and the sidecar come from `src/pipeline.js`, which the app imports too.
Input is NIfTI only: convert DICOM with dcm2niix first, or use the web app.
`self-check` runs the module on a ramp phantom (the tissue's coefficient of variation must fall by half or more) and loads the MindGrab package.

The portable archives are built by `exes/node-cli` (`release.json`) in `.github/workflows/n4-native.yml`.

### Accuracy

`validation/cli-check.mjs` is the release gate. It runs the command line on the three pinned examples in `apps/n4/examples.json`: the ds005134 multi-shell slab with its sidecar, the 3D T1-weighted head and the single-shell DWI.
The command line's MindGrab mask must equal the recorded one, and the corrected image, the bias field and the mask must equal the web app's downloads once decompressed; the `.bval`, `.bvec` and sidecar must equal them byte for byte. A second run with that mask through `--mask` must write the same files.
`validation/browser-reference.json` holds the downloads, which `apps/n4/e2e/reference.spec.js` recorded through the built app's `correct` automation in Chromium. The spec gives the app the command line's CPU MindGrab mask through its mask input, because the app's MindGrab prefers a GPU; `@neurodesk/node-drivers` holds that CPU MindGrab to the browser's byte for byte.

```bash
node packages/n4/validation/cli-check.mjs
node packages/n4/validation/cli-check.mjs --executable path/to/n4
N4_BROWSER_REFERENCE=write pnpm --filter n4 exec playwright test e2e/reference.spec.js
```

Rerecord the reference after a change to the module, `src/pipeline.js`, MindGrab or the app's NIfTI writing.
Cite Tustison et al. (2010), as the app's Cite dialog does.

## Rebuild

Docker, curl and tar are required:

```bash
bash packages/n4/scripts/build.sh /var/tmp/n4-build          # rebuild and copy into wasm/
bash packages/n4/scripts/build.sh --check /var/tmp/n4-build  # rebuild and compare with wasm/
```

The script downloads ANTs at `52bc0ab588102682587303d31c720de94e6ef6c1` and compiles in `itkwasm/emscripten@sha256:d6c35290…`, one job, with an 8 GB container limit (`N4_BUILD_MEMORY`).

The build is byte-reproducible: a rebuild gives the committed `n4-bias.wasm` and `n4-bias.mjs` byte for byte.
The `n4-wasm-source` workflow runs `--check` each week and by hand (Actions, "Run workflow"); it fails when either file differs and keeps the rebuilt files as the `n4-rebuilt` artifact.
The one cause of difference was ANTs' `ANTsVersion.cxx`, which compiles in `__DATE__ " " __TIME__`.
The script sets `SOURCE_DATE_EPOCH=1792348789` (Oct 18 2026 18:39:49 UTC, when the committed module was built), which Clang uses for both macros.
The sources and the build tree are mounted at the same container paths on every host, and the build tree starts empty each time.
Rebuilds in different directories on two Linux x86-64 Docker hosts gave the same bytes.
We did not test an arm64 host or amd64 emulation (for example Docker Desktop on Apple silicon).
Use the workflow's x86-64 runner as the reference.
