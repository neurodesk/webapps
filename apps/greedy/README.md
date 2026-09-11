# Greedy

Greedy performs affine NMI or affine plus nonlinear stationary-velocity NMI
registration entirely in the browser. The interface keeps moving, stationary,
and resliced images visible in separate linked panels. NiiVue provides the
viewers, dcm2niix converts DICOM inputs, MindGrab brain extracts custom images,
and the threaded `@neurodesk/greedy` WebAssembly package performs registration.

The supplied examples are already brain extracted. A custom input is marked as
requiring extraction; the user can run the visible **Brain extract moving
image** action, and registration automatically extracts any remaining custom
moving or stationary input before Greedy starts.

## Example data

The registration-family examples live in the `neurodeskorg/webapps` Hugging
Face dataset under `reg/templates` and `reg/moving`. From the webapps repository
root, prepare and upload the two Greedy examples with:

```bash
cd /Users/chris/src/webapps
GREEDY_DATA_SOURCE=${GREEDY_DATA_SOURCE:-../cfireants/validate/medium}
mkdir -p reg/templates reg/moving
cp "$GREEDY_DATA_SOURCE/MNI152_T1_1mm_brain.nii.gz" reg/templates/
cp "$GREEDY_DATA_SOURCE/t1_brain.nii.gz" reg/moving/
hf auth login
hf upload neurodeskorg/webapps ./reg reg --repo-type dataset
```

The app pins dataset revision `544f1362f367355e61a85e0694f5075aba2792b6`
so releases remain reproducible.

## Build and test

The Greedy executable source is in `exes/greedy`. Its browser build is committed
under `packages/greedy/wasm`, included in package releases, and copied into the
app build alongside MindGrab's runtime files:

```bash
pnpm --filter @neurodesk/greedy build:wasm
pnpm --filter @neurodesk/greedy test
pnpm --filter greedy build
pnpm --filter greedy test:e2e
```

The app does not fetch executable code from Hugging Face or a GitHub release.
Hugging Face stores example data; package releases carry the browser module;
native release archives can be published separately from `exes/greedy`.

## MindGrab release note

The app pins `@brainchop/mindgrab` `0.1.20260813`. In that release, a failed or
timed-out WASM startup can remain cached; reload the page before retrying brain
extraction. [brainchopC pull request #13](https://github.com/neuroneural/brainchopC/pull/13)
fixes startup reporting and retry behavior and will be adopted with the next
MindGrab release. When upgrading, rebuild the app and rerun the unit, browser,
and interactive brain-extraction checks before removing this note.
