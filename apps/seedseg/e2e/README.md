Run `pnpm --filter seedseg build` then `pnpm --filter seedseg exec playwright test`.
The test starts the app locally and runs all four published SeedSeg ONNX models.
Runtime and model files remain generated assets outside source control.

The synthetic fixture represents a cropped T1 prostate: a uniform body ellipse, a brighter
prostate ellipsoid and three dark cylindrical fiducials at known voxel coordinates. Besides
transport, completion, geometry, finite probability maps and downloaded file checksums, the
test requires exactly three marker components, each centred within one voxel of a planted
fiducial and together covering at least 90 % of the planted voxels. An empty or displaced
marker mask fails. The planted geometry is the reference; no earlier app output is.

That is a localisation check on a phantom, not clinical validation. The models mark a wider
region than the planted void (Dice 0.26 against the planted voxels), and on this phantom the
consensus rests mainly on one of the four models; two stay silent. Clinical sensitivity and
specificity remain unverified: SeedSeg has no public clinical reference case. The fixture is
not offered as an app example.
