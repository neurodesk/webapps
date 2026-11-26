# VesselCharter (web)

Browser-native 3D blood vessel characterisation from binary NIfTI vessel segmentations (such as VesselBoost outputs). Measures diameter, branching topology, centerline length, tortuosity, diameter-stratified distributions, and optional brain/ROI vascular density entirely client-side inside a Module Web Worker.

All numerical kernels and serializers live in [`packages/vesselcharter`](../../packages/vesselcharter/README.md) (`@neurodesk/vesselcharter`), shared byte-for-byte with the standalone `vesselcharter` command line.

## Development

```sh
pnpm --filter vesselcharter dev
pnpm --filter vesselcharter build
pnpm --filter vesselcharter test
pnpm --filter vesselcharter test:e2e
```
