# Automation verification

Build the browser runtime and run the default checks:

```sh
pnpm --filter calmar build
pnpm --filter calmar exec playwright test e2e/automation.spec.js
```

The supplied-lesion test uses the committed 64-voxel lesion on the Yeo 7 atlas
grid and the pinned connectivity pack. Its output must equal the Visual
network's connectivity channel at every voxel. A separate test rejects a mask
with matching dimensions but a shifted affine.

Full structural candidate inference is opt-in:

```sh
CALMAR_AUTOMATION_IMAGE=example \
  pnpm --filter calmar exec playwright test e2e/automation.spec.js --grep 'real structural'
```

`example` downloads the stroke T1 declared in `examples.json` and checks SHA-256
`725a37bf9556c6776a7be552597999df67d175a44eafc03252db058e8f5c5cad`.
Set `CALMAR_AUTOMATION_IMAGE` to a local T1 path to use another image.
Downloads and reports stay under `$TMPDIR/neurodesk-calmar-automation`.
`CALMAR_AUTOMATION_TIMEOUT_MS` sets the inference deadline; the default is ten
minutes. Browser diagnostics are saved beside the reports and attached to the
Playwright result. A renderer failure ends the check immediately.

The candidate check runs the existing SynthStrip, prealignment and SynthStroke
handlers. It checks native-space geometry, binary output and the explicit
unconfirmed review state. It does not measure segmentation accuracy against an
expert lesion annotation. It never confirms a lesion or resumes registration.

The supplied-lesion and full structural checks passed on Linux. The structural
example completed in 7.3 minutes and produced a binary 160×256×256 candidate
with 65,607 foreground voxels. Its report requires review and leaves the lesion
unconfirmed. This checks execution, geometry, artifact hashes, and review state,
not accuracy against an expert lesion annotation. Run the opt-in check on the
target machine before treating that machine's execution as verified.

## Review-to-report orientation regression

`mask-orientation.spec.js` uses asymmetric, non-cubic MRI phantoms with a known
world-space lesion. It checks the real NiiVue drawing against an anatomical
landmark, then compares downloaded and confirmed native masks voxel-for-voxel
and checks that the reporting-grid mask stays in the same hemisphere. The old
raw-drawing/native-header combination is explicitly checked to fail on LAS.
All 48 signed axis permutations run through the T1 route. Representative
flips and permutations also run through b0-as-anatomy, DWI+ADC, DWI+b0,
DWI+ADC+b0, and separate T1+diffusion inputs (different storage orientations),
plus uploaded masks, manual drawings, gzip, qform-only and oblique images.
Four additional cases use actual DICOM conversion through each image picker
before checking confirmation. No clinical scans are stored by these tests.

Registration is deliberately an identity world-space mapping in this suite:
it isolates the handoff from neural segmentation and registration accuracy.
These tests do not establish clinical accuracy or rule out problems caused
by incorrect source geometry or a failed registration on a particular scan.
