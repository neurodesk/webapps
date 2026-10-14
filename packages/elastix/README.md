# @neurodesk/elastix

The elastix web app's registration pipeline, and a command line that runs it
without a browser. The web app imports the presets, the float32 cast, the
TransformParameters chain, source handling and the transform estimate from
here.

## Command line

`elastix-register` runs the web app's registration in Node. It calls the same
ITK-Wasm pipelines as the browser (`@itk-wasm/elastix` 2.1.0, `image-io`
1.6.1, `transform-io` 1.1.0) through itk-wasm's Node runner, which loads the
`.wasm.zst` files shipped inside those packages. It needs no browser, GPU or
network.

The command is not called `elastix`: native elastix installs `elastix` and
`transformix`, which take different arguments, and this one must never
shadow them.

### Install

Download the release for your platform from the web app's Standalone dialog:
Linux x64, Windows x64 or macOS on Apple silicon. Each contains a private
Node.js runtime.

On Linux, extract the archive and keep the directory intact:

```bash
tar -xzf elastix-register-VERSION-linux-x64.tar.gz
./elastix-register-VERSION-linux-x64/elastix-register self-check
```

On Windows, use `Expand-Archive` and `elastix-register.exe`.

On macOS, the release is an installer package signed with a Developer ID and
notarized by Apple. It installs the command line in
`/usr/local/lib/neurodesk/elastix-register` and the `elastix-register` command
in `/usr/local/bin`:

```bash
sudo installer -pkg elastix-register-VERSION-macos-arm64.pkg -target /
elastix-register self-check
```

To uninstall, delete `/usr/local/lib/neurodesk/elastix-register` and
`/usr/local/bin/elastix-register`, then run
`sudo pkgutil --forget org.neurodesk.elastix-register`.

From a checkout of this repository:

```bash
pnpm install
node packages/elastix/bin/elastix-register.js --help
```

### Commands

```bash
elastix-register moving.nii.gz fixed.nii.gz results --method affine
elastix-register moving.nii.gz fixed.nii.gz results --method bspline --grid-spacing 10
elastix-register moving.nii.gz fixed.nii.gz results --parameter-file p0.txt --parameter-file p1.txt
elastix-register self-check
```

The options are the `register` operation's parameters in
`apps/elastix/automation.json`: `--method` (`rigid`, `affine` or `bspline`,
default `affine`), `--resolutions` (1 to 6, default 3) and `--grid-spacing`
(final B-spline control-point spacing, default 10). `--parameter-file`
replaces the preset with elastix parameter files, applied in name order, as
the web app's parameter-file input does. The elastix log goes to standard
error; standard output lists the written files. `download-models` exists for
the shared packager and does nothing.

Inputs are NIfTI, the other self-contained ITK formats (NRRD, MHA, MGH, ...),
TIFF/OME-TIFF or OME-Zarr `.ozx` archives, 2D or 3D with one scalar channel.
TIFF and OME-Zarr use the finest pyramid level within 2^24 voxels. Convert
DICOM with dcm2niix first, and pack an OME-Zarr folder as `.ozx`. Both images
are registered as float32 copies, as in the web app.

The output directory must be new or empty.

### Outputs

The web app's downloads, named after the moving image:

| File | Content |
| --- | --- |
| `<moving>_registered.nii.gz` | Moving image resampled onto the fixed grid |
| `<moving>_transform.h5` | ITK HDF5 transform; rigid and affine runs only |
| `<moving>_transform.ome.zarr.ozx` | OME-Zarr RFC-5 fixed-to-moving transform |
| `<moving>_TransformParameters.N.toml` | elastix parameter files, one per stage |

The parameter files are chained through `InitialTransformParameterFileName`,
so transformix given the last one applies every stage. The OME-Zarr transform
is one `affine` for rigid and affine runs and a `displacements` field on the
fixed grid otherwise.

Two of the web app's downloads are missing:

- The registered OME-Zarr image. The registered image is NIfTI only.
- The ITK HDF5 transform of a B-spline run. `@itk-wasm/transform-io` 1.1.0
  fails writing a BSpline transform; the web app no longer offers it either.
  Use the TransformParameters files or the OME-Zarr transform.

ngff-zarr, which the web app uses for OME-Zarr, decodes and encodes arrays on
Web Workers it starts from blob: URLs, which Node cannot run. The command line
reads OME-Zarr and TIFF pixel data with zarrita on the main thread, and writes
the displacements store with zarrita and its own metadata
(`src/node-ngff.js`). The affine archive and all metadata other than the
displacements store's still come from ngff-zarr.

### Accuracy

`validation/cli-check.mjs` is the release gate. It registers the web app's
pinned example (`t1-mni`, a T1 brain to the MNI152 1 mm template) with each
preset and compares every output with `validation/t1-mni-reference.json`,
which holds the web app's own downloads, recorded by
`apps/elastix/e2e/reference.spec.js` through the built app in Chromium:

- The TransformParameters files must be byte for byte identical.
- The HDF5 transform must read back to identical parameters. HDF5 stamps
  modification times, so its bytes differ between any two writes.
- The OME-Zarr transform's metadata documents and decoded array values must
  be identical. The archive's bytes differ only in the zip timestamps.
- The registered image must lie on the fixed grid with the reference's header
  geometry and datatype, its voxel mean and std within a relative 1e-7 and its
  correlation with the fixed brain within 1e-4 of the reference's. The
  smallest legitimate change to a run, elastix's sampler seed (`RandomSeed`
  121213 instead of 121212), moved the rigid preset's mean by 1.7e-6 and std
  by 7.5e-6, and the B-spline preset's correlation by 1.1e-3; each limit is a
  tenth or less of that. Whether the voxels hash identically is reported too.

The check then registers the example template, downsampled to 3 mm, against a
copy turned 8 degrees and shifted, and requires the transform composed from
the TransformParameters files to recover that displacement within 1 mm, as
the web app's automation test does. Last, it registers a 2D pair read from an
OME-Zarr `.ozx` and a pyramidal OME-TIFF and requires the known shift.

The pipelines are single-threaded WebAssembly with a fixed sampler seed. On
the validation host the command line reproduced the web app's registered
images, parameter files and OME-Zarr transforms bit for bit for all three
presets. A run took 15 s (rigid), 25 s (affine) and 120 s (B-spline) with
the command line, and 20 s, 30 s and 119 s in headless Chromium.

```bash
node packages/elastix/validation/cli-check.mjs
node packages/elastix/validation/cli-check.mjs --executable path/to/elastix-register
ELASTIX_BROWSER_REFERENCE=write pnpm --filter elastix exec playwright test e2e/reference.spec.js
```

Rerecord the browser reference when an ITK-Wasm package, ngff-zarr or a
preset changes; the check refuses a reference recorded with another elastix
pipeline build. The `web-app-reference` job in `elastix-native.yml` reruns
the browser recording with `ELASTIX_BROWSER_REFERENCE=check`.
