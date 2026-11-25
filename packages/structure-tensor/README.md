# @neurodesk/structure-tensor

2D and 3D Gaussian structure-tensor fibre orientation, coherency, and energy analysis (the OrientationJ method) for microscopy TIFF, PNG, JPEG, and NIfTI images and stacks.

## Command line

```bash
structure-tensor input.tif results
structure-tensor input.nii.gz results --sigma 1 --rho 3 --min-coherency 0.2 --min-energy 0.01
structure-tensor slice01.tif slice02.tif slice03.tif results
structure-tensor self-check
```

## Outputs

For 2D inputs:
- `<stem>_orientation.tif` (or `.nii.gz` for NIfTI input), `<stem>_coherency.tif`, `<stem>_energy.tif`
- `<stem>_hsb.png` — HSB colour survey
- `<stem>_distribution.csv`, `<stem>_summary.json`

For 3D inputs:
- `<stem>_azimuth.tif`, `<stem>_elevation.tif`, `<stem>_coherency.tif`, `<stem>_energy.tif`, `<stem>_direction_rgb.tif` (or `.nii.gz` for NIfTI input)
- `<stem>_fibre_vectors.nii.gz` — 4D unit fibre direction vectors
- `<stem>_distribution.csv`, `<stem>_summary.json`

## License

Apache-2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
