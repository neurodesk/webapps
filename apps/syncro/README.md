# SYNcro webapp

SYNcro normalizes clinical brain scans to the MNI152 1 mm template entirely in
the browser. Its default stages match the native
[`rordenlab/SYNcro`](https://github.com/rordenlab/SYNcro) command:

1. SynthSR creates a synthetic T1-weighted image from the primary scan.
2. MindGrab extracts its brain. SynthStrip is an optional alternative.
3. Greedy estimates affine and deformable normalization. ANTs SyN is optional.
4. niimath prepares and thresholds lesion masks and masks the normalized primary
   scan with the normalized synthetic brain.

The app accepts three explicit inputs. The primary scan is required. A binary
lesion map and a pathological modality scan are optional. Without a pathological
scan, the lesion must share the primary grid. With one, the lesion must share the
pathological grid; that scan and lesion are aligned to the primary before MNI
normalization. Each slot accepts a NIfTI image or a complete DICOM series by file
picker or drag and drop.

Lesion maps may use any two discrete values (for example, 0/1 or 0/255); they are
scaled to 0/1 like native SYNcro. Inputs whose basenames would produce duplicate
native output names are rejected before inference.

The `Primary is CT` and `Keep native-space synthetic T1` checkboxes correspond to
native SYNcro's `--ct` and `--keep-synth` options. Output names also follow native
SYNcro: `w*` for normalized inputs, `wb*` for the normalized brain-extracted
primary, `wbt1*` for the normalized brain-extracted synthetic T1, and `t1*` only
when the synthetic intermediate is retained.

## Tutorials and viewer

The tutorial selector reproduces all four native walkthroughs:

- TRACE lesion on a pathological TRACE scan with T1w as the primary scan.
- TRACE as both the primary and lesion reference.
- T1w with a lesion in the same grid.
- CT with a lesion, `--ct`, and `--keep-synth` enabled.

The seven deidentified inputs live in the project-owned Hugging Face dataset.
`models/syncro-tutorials.manifest.json` pins immutable revision
`444fd496704f2ac5fd06ed28d614f1b6acfc6fcb` and verifies every byte length and
SHA-256 before use. `models/syncro-tutorials.README.md` records provenance and
upstream terms. The CT tutorial is non-commercial, and redistribution permission
for the derived `T1w-lesion.nii.gz` annotation still needs confirmation before a
public release.

SYNcro uses one NiiVue instance. The `Image shown` menu switches between input
scans and generated scalar images. Lesion maps are deliberately omitted from the
menu: the native lesion overlays the primary or pathological input that owns its
grid, and the normalized lesion overlays every MNI-space output at 50% opacity.
`Edit lesion` in Results opens the shared mask editor on the normalized lesion
over the normalized primary scan. Apply replaces `w<lesion>` in the result archive
with the edited uint8 NIfTI; automation results keep the computed lesion.

## Local development

From the repository root:

```bash
pnpm --filter syncro dev
```

Open `http://127.0.0.1:5175/syncro/`. Cross-origin isolation is required for
threaded WebAssembly. `scripts/copy-runtime-assets.mjs` stages the ignored
MindGrab, Greedy and ANTs runtime trees into `public/`; do not commit generated
runtime files.

For a production check:

```bash
pnpm --filter syncro build
pnpm --filter syncro test
pnpm --filter syncro test:e2e
```

The browser downloads checksum-pinned models, the MNI template, and tutorial
images from Hugging Face. User-selected images remain local. Full-volume SynthSR
uses optimized WebGPU by default, with CPU WebAssembly as the fallback; no
approximate tiling is enabled. Volumes above the largest validated 2.25 GiB
activation are attempted when the adapter advertises sufficient per-buffer limits;
the browser reports an allocation error if total device memory is insufficient.
Changing inputs or leaving the page cancels an in-progress result archive so stale
outputs are never downloaded.
Review the normalized acquired scan, lesion and synthetic brain before using
research outputs.

## Agent automation

The `normalize` automation operation accepts an explicit `primary` NIfTI or DICOM input and optional `lesion` and `pathological` roles. A lesion must match the pathological image grid when supplied, otherwise the primary grid. It runs the same worker as the interface, waits for processing and viewer completion, and returns the normalized images and pipeline provenance. `keepSynth` adds the native synthetic T1; optional lesion and pathological inputs add their normalized counterparts. Parameters select the existing SynthSR backend, brain extractor, normalization engine and CT handling. The image viewer exposes the actual input/output selections as tabs. Cancellation terminates the pipeline worker. Full normalization requires its published models and a suitable inference backend; contract and geometry checks do not establish scientific model parity.
