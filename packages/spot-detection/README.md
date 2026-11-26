# @neurodesk/spot-detection

Single-molecule FISH (smFISH) spot detection for 2D and 3D microscopy TIFF stacks: a faithful JavaScript port of Big-FISH 0.6.2 (anisotropic 3D/2D Laplacian of Gaussian filter, automatic elbow threshold, 3D/2D Gaussian sub-pixel localization, per-cell spot counting, and NIfTI spot-ring overlay export).

## Command line

```bash
spot-detection stack.tif results
spot-detection stack.tif results --labels cells.tif --voxel-z 300 --voxel-yx 103
spot-detection stack.tif results --projection --threshold 203 --no-subpixel
spot-detection self-check
```

## Outputs

- `<stem>[_mip]_spots.csv` — detected spots with voxel coordinates, sub-pixel coordinates (when enabled), physical coordinates in nm, LoG response, raw intensity, and optional cell label.
- `<stem>[_mip]_spots.nii.gz` — NIfTI-1 spot-ring overlay matching the input image geometry.
- `<stem>[_mip]_cell_counts.csv` — per-cell spot counts and areas (written when `--labels` is supplied).
- `<stem>[_mip]_provenance.json` — run parameters, LoG sigmas, threshold, spot count, and timing.

## License

BSD-3-Clause. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
