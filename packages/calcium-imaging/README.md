# `@neurodesk/calcium-imaging`

Two-photon calcium imaging motion correction, local-correlation ROI extraction, neuropil-corrected ΔF/F traces and OASIS AR(1) spike deconvolution core and portable command line.

## Usage

```bash
# Verify installation with synthetic registration phantom
calcium-imaging self-check

# Run full rigid motion correction, ROI extraction, ΔF/F traces and OASIS deconvolution
calcium-imaging movie.ome.tif results

# Piecewise-rigid registration with explicit frame rate
calcium-imaging movie.tif results --motion piecewise --frame-rate 15.0
```

No network connection or external model files are required.
