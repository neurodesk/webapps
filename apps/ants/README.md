# ANTs

ANTs registers a moving image to a stationary image entirely in the browser:
an affine stage followed by SyN symmetric diffeomorphic registration with the
Mattes mutual-information metric, using the ANTs 2.6.2 WebAssembly kernel and
ANTsPy `SyN` schedule that SYNcro already ships (`packages/registration`). The
interface is Greedy's: moving, stationary and resliced images in three linked
NiiVue panels, dcm2niix for DICOM, MindGrab brain extraction for custom inputs.

The supplied examples are already brain extracted and load on start. A custom
input is flagged as not brain extracted, and a **Brain extract** button under
each image runs MindGrab on demand; registration never modifies the inputs and
a scalp-bearing scan registers with artifacts, so the technical log notes it. SyN on
the 1 mm examples took 49 s on an Apple M4 Pro and is slower on older hardware, so
registration starts when you press **Register images**. Outputs: the registered image, the affine matrix and the
forward and inverse warps, in ANTs' own formats.

## Build and test

```bash
pnpm --filter ants dev        # stages the ANTs and MindGrab runtime into public/ (gitignored), then Vite
pnpm --filter ants test
pnpm --filter ants lint
pnpm --filter ants build
pnpm --filter ants test:e2e   # ANTS_LIVE_DATA=1 additionally registers the real 1 mm examples
```

Example data comes from the `reg/` folder of the `neurodeskorg/webapps` Hugging
Face dataset at a pinned revision, shared with Greedy.

## Command line

`ants` from `packages/ants` runs the same registration with Node, on the same
WebAssembly kernel and schedule:

```bash
ants moving.nii.gz fixed.nii.gz results
```

It writes the four downloads under the web app's names. It registers the given
images as they are: brain extract them beforehand, for example with SynthStrip,
until MindGrab has a Node runtime
([#162](https://github.com/neurodesk/webapps/issues/162)). It has no DICOM
import. Portable archives for Linux x64, Windows x64 and macOS arm64 bundle
their own Node runtime. See [packages/ants/README.md](../../packages/ants/README.md).

## Agent automation

The published `automation.json` describes the typed browser operation. Desktop
MCP uses the same processing function as the Run button and returns the exact
output files with input and artifact checksums. See
[desktop automation](../../packages/desktop/AUTOMATION.md) for connection details.

`register` requires `moving` and `fixed` image roles and runs the existing SyN
schedule. Outputs include the registered NIfTI, affine transform, forward warp
and inverse warp. The report records the actual seed and iteration schedules.
The three image viewers expose their crosshairs and layout tabs.
Both image roles accept NIfTI or DICOM. Ambiguous DICOM conversion requires an
explicit series selection; the operation never guesses roles from filenames.
