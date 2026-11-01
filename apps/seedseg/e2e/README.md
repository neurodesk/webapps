Run `pnpm --filter seedseg build` then `pnpm --filter seedseg exec playwright test`.
The tests start the production app locally and run the default v2 network and all four legacy SeedSeg models.
Runtime and model files remain generated assets outside source control.

The synthetic fixture represents a cropped T1 prostate: a uniform body ellipse, a brighter
prostate ellipsoid and three dark cylindrical fiducials at known voxel coordinates. Besides
transport, completion, geometry, finite probability maps and downloaded file checksums, the
legacy test requires exactly three marker components, each centred within one voxel of a planted
fiducial and together covering at least 90 % of the planted voxels. An empty or displaced
marker mask fails. The planted geometry is the reference; no earlier app output is.

That is a localisation check on a phantom, not clinical validation. The models mark a wider
region than the planted void (Dice 0.26 against the planted voxels), and on this phantom the
consensus rests mainly on one of the four models; two stay silent. Clinical sensitivity and
specificity remain unverified: SeedSeg has no public clinical reference case. The fixture is
not offered as an app example.

The v2 test checks default model identity, native-grid outputs, ranked marker labels,
detection reports, download checksums and recomputed marker summaries after editing.
An oriented-image case checks navigation through world coordinates. It also blocks the optional dicompare
host to verify that segmentation starts without it. V2 accuracy needs its own
clinical reference; the legacy phantom tolerances remain unchanged.

The startup test converts generated DICOM files while a report-host request stays
unresolved, then reads the converted NIfTI and checks that the files were retained.
It also checks keyboard access to the shared inference tooltips.

The macOS GPU CI job sets `NEURODESK_HARDWARE_GPU=1`. In that mode the default
test requires actual WebGPU execution, reruns on WASM and compares detections
with the upstream one-voxel criterion used by the command-line validation.
Separate hardware cases compare all five folds and mirrored fold 0 with WASM.
The hardware configuration uses full Chromium and verifies the adapter identity.
On a machine with a hardware WebGPU adapter, run:

```sh
NEURODESK_HARDWARE_GPU=1 pnpm --filter seedseg exec playwright test
```
