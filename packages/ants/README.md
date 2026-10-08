# @neurodesk/ants

A command line for the ANTs web app's registration, and the download names,
which the web app imports from here.

## Command line

`ants` runs the web app's `register` operation in Node. It loads the same
ANTs 2.6.2 WebAssembly kernel as the browser (`@neurodesk/registration`, checked
against its pinned SHA-256) and runs the same ANTsPy 0.6.1
`type_of_transform='SyN'` schedule with random seed 42 on one thread. It needs
no browser, GPU or network.

### Install

Download the release for your platform from the web app's Standalone dialog:
Linux x64, Windows x64 or macOS on Apple silicon. Each contains a private
Node.js runtime.

On Linux, extract the archive and keep the directory intact:

```bash
tar -xzf ants-VERSION-linux-x64.tar.gz
./ants-VERSION-linux-x64/ants self-check
```

On Windows, use `Expand-Archive` and `ants.exe`.

On macOS, the release is an installer package signed with a Developer ID and
notarized by Apple. It installs the command line in
`/usr/local/lib/neurodesk/ants` and the `ants` command in `/usr/local/bin`:

```bash
sudo installer -pkg ants-VERSION-macos-arm64.pkg -target /
ants self-check
```

Native ANTs also installs commands into the `PATH`, but none named `ants`. To
uninstall, delete `/usr/local/lib/neurodesk/ants` and `/usr/local/bin/ants`,
then run `sudo pkgutil --forget org.neurodesk.ants`.

From a checkout of this repository:

```bash
pnpm install
node packages/ants/bin/ants.js --help
```

### Commands

```bash
ants moving.nii.gz fixed.nii.gz results
ants self-check
```

`download-models` exists for the shared packager and does nothing: ANTs uses
no model files.

The `register` operation in `apps/ants/automation.json` has no parameters, so
the command line has no options beyond `--help`. Registration is an affine
stage (Mattes mutual information, 2100x1200x1200x0 iterations) followed by SyN
(Mattes, 40x20x0 iterations), exactly as in the web app. The ANTs log goes to
standard error; standard output lists the written files.

The command line leaves out two parts of the web app:

- Brain extraction. The command line registers the given images as they are,
  because MindGrab has no Node runtime yet
  ([#162](https://github.com/neurodesk/webapps/issues/162)). Brain extract both
  images first, for example with SynthStrip, when they still contain scalp.
- DICOM import. Convert DICOM with dcm2niix first.

The WebAssembly kernel can address at most 4 GiB. Registering a 1 mm T1 brain
to the 1 mm MNI152 template used a 2.79 GB heap and 1.95 GB resident memory.
For larger images use the native ANTs container (`vnmd/ants_2.6.5`), which
runs a newer ANTs and is not checked against this schedule.

The output directory must be new or empty.

### Outputs

The four files the web app offers for download, named after the moving image:

| File | Content |
| --- | --- |
| `<moving>_registered.nii.gz` | Moving image resliced onto the fixed grid |
| `<moving>_0GenericAffine.mat` | Affine transform, ITK format |
| `<moving>_1Warp.nii.gz` | Forward displacement field, on the fixed grid |
| `<moving>_1InverseWarp.nii.gz` | Inverse displacement field, on the fixed grid |

Apply them to another image in moving space with native ANTs:

```bash
antsApplyTransforms -d 3 -i other.nii.gz -r fixed.nii.gz -o other_in_fixed.nii.gz \
  -t moving_1Warp.nii.gz -t moving_0GenericAffine.mat
```

### Accuracy

`validation/cli-check.mjs` is the release gate. It registers the web app's
pinned example (`t1-mni`, a T1 brain to the MNI152 1 mm template) with the
command line and compares every output with `validation/t1-mni-reference.json`.
That file holds the web app's own four downloads, recorded by
`apps/ants/e2e/reference.spec.js` through the built app, its automation and its
registration worker, in Chromium.

For the registered image and both warps, the output must lie on the fixed
image's grid (every corner voxel within 0.001 mm), its stored header geometry
(dims, pixdim, qform, sform) and datatype must equal the browser reference's,
and its voxels must hash identically to the browser reference's. The affine
file's bytes must be identical. ITK writes qform and sform code 1 where the
MNI template has 4, so the outputs are compared with the fixed image by
position, not by stored header.

The kernel is single-threaded WebAssembly with a fixed seed, so its output is
bit-identical wherever it runs. The web app in Chromium and the packaged
command line on Linux x64, Windows x64 and macOS arm64 produced the same voxels
in all three images and the same affine bytes. Packaged registrations took
124 s (Linux), 82 s (Windows) and 102 s (macOS) on the CI runners. The check also reports statistics against limits, to show how far a
differing output is: voxel mean and std (relative 1e-6), the registered image's
correlation with the fixed brain (1e-4) and the affine parameters (1e-3). The
smallest legitimate change to the schedule is a different seed. Seed 43
instead of 42 moved the registered image's mean by 3.8e-5 and its std by
1.1e-5 (relative), its correlation by 1.2e-3 and the largest affine parameter
by 0.079. Each limit is about a tenth of that shift, so every statistic fails
for a seed change.

```bash
node packages/ants/validation/cli-check.mjs
node packages/ants/validation/cli-check.mjs --executable path/to/ants
ANTS_BROWSER_REFERENCE=write pnpm --filter ants exec playwright test e2e/reference.spec.js
```

Rerecord the browser reference when the kernel changes; the check refuses a
reference recorded with another kernel. The `web-app-reference` job in
`ants-native.yml` reruns the browser recording with
`ANTS_BROWSER_REFERENCE=check`. On the validation host a registration took
137 to 156 s with the command line and 140 to 210 s in the web app in headless
Chromium; the web app's README reports 49 s on an Apple M4 Pro.
