# @neurodesk/edgereg

EdgeReg's registration method, which the web app imports from here, and a
command line that runs it in Node.

## Method

`src/registration.js` holds the method once:

```text
niimath MOVING -gz 0 [-robustfov] -allineate FIXED OUT -odt input
```

niimath's `-allineate` is a port of AFNI's 3dAllineate (fast engine). It
estimates an affine transform from the moving image to the fixed image and
reslices the moving image onto the fixed grid, uncompressed and in the moving
image's datatype. `-robustfov` first crops the moving image to a 170 mm field
of view from the top of the head, removing the neck.

The web app chains these calls on `@niivue/niimath`'s browser worker. The
command line builds the same chain, reads the argv the worker would run, and
passes it to `runNiimath` from `@neurodesk/node-drivers/niimath` with the
same `@niivue/niimath` 1.4.20260909 WebAssembly build.

## Command line

`edgereg` runs the web app's `register` operation. It needs no browser, GPU,
network or model files.

### Install

Download the release for your platform from the EdgeReg app's Standalone
dialog: Linux x64, Windows x64 or macOS on Apple silicon. Each contains a
private Node.js runtime.

On Linux, extract the archive and keep the directory intact:

```bash
tar -xzf edgereg-VERSION-linux-x64.tar.gz
./edgereg-VERSION-linux-x64/edgereg self-check
```

On Windows, use `Expand-Archive` and `edgereg.exe`.

On macOS, the release is an installer package signed with a Developer ID and
notarized by Apple. It installs the command line in
`/usr/local/lib/neurodesk/edgereg` and the `edgereg` command in
`/usr/local/bin`:

```bash
sudo installer -pkg edgereg-VERSION-macos-arm64.pkg -target /
edgereg self-check
```

To uninstall, delete `/usr/local/lib/neurodesk/edgereg` and
`/usr/local/bin/edgereg`, then run `sudo pkgutil --forget org.neurodesk.edgereg`.

### Commands

```bash
edgereg moving.nii.gz fixed.nii.gz results
edgereg moving.nii.gz fixed.nii.gz results --robust-fov
edgereg self-check
```

`--robust-fov` is the automation parameter `robustFov` and the app's robust
field of view checkbox. It is off by default, as in the app. The output
directory must be new or empty. Standard output lists the written file.
Standard error gets one JSON line with the settings that produced it: the
`robustFov` value, the niimath build and the argv.

The command line has no DICOM import. Convert DICOM with dcm2niix first, or
use the web app, which converts it in the browser. `self-check` registers a
synthetic block to a shifted copy and fails unless it lands on the copy.
`download-models` exists for the shared packager and does nothing.

Native niimath runs the same method as
`niimath moving.nii.gz -allineate fixed.nii.gz out.nii`, for example from the
`vnmd/niimath` container. Its output differs from the WebAssembly build's by
floating-point rounding (see Accuracy).

### Output

| File | Content |
| --- | --- |
| `<moving>_registered.nii` | Moving image resliced onto the fixed grid, in its own datatype |

This is the file the web app offers for download, under the same name.

### Accuracy

`validation/cli-check.mjs` is the release gate. It registers the web app's
pinned example (`t1-mni`, a cropped T1 to the MNI152 1 mm template) with the
command line. It compares the output with `validation/t1-mni-reference.json`,
which holds the web app's own download. `apps/edgereg/e2e/reference.spec.js`
recorded it through the built app, its automation and its niimath worker, in
Chromium.

The output must lie on the fixed grid. Its header bytes and its voxels must
hash identically to the web app's. Its value range, mean, standard deviation
and correlation with the fixed image must be equal to the web app's. The
command line also has to write exactly one file under the web app's name, and
print only its path. Its provenance must name the niimath build the browser
reference was recorded with.

With `--native PATH`, the check also runs native niimath with the same argv
and holds it to limits instead of hashes. Native niimath rounds differently
and converges on a slightly different affine. On the example,
rordenlab/niimath 95645c24 on Linux x64 changed 29 % of the voxels, by up to
78 of 255. Its correlation with the WebAssembly output was 0.99953. Shifting
the WebAssembly output by one voxel lowers that correlation to 0.960, and
blending in a tenth of the neighbouring voxel lowers it to 0.99961. The limits
are therefore:

- 1 - r at most 0.004, a tenth of a one-voxel shift's (measured 4.7e-4)
- voxel mean and std within 0.2 % (measured 5.4e-4 and 6.7e-5)
- 99.9th percentile of the absolute voxel difference at most 24, twice the
  measured 12 (a one-voxel shift gives 80)
- correlation with the fixed image within 0.001 (measured 1.5e-4)

```bash
node packages/edgereg/validation/cli-check.mjs
node packages/edgereg/validation/cli-check.mjs --executable path/to/edgereg
node packages/edgereg/validation/cli-check.mjs --native path/to/niimath
EDGEREG_BROWSER_REFERENCE=write pnpm --filter edgereg exec playwright test e2e/reference.spec.js
```

Rerecord the browser reference when the app's niimath pin changes. The
`web-app-reference` job in `edgereg-native.yml` reruns the browser recording
with `EDGEREG_BROWSER_REFERENCE=check`. The `native-niimath` job builds
niimath from source and runs the `--native` comparison. On the validation
host the command line registered the example in 8 to 10 s with a 0.3 GB peak
resident set. The web app took 10 s in headless Chromium.
