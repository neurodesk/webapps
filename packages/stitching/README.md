# `@neurodesk/stitching`

Microscopy tile grid phase-correlation stitching, global translation optimisation and linear-blending fusion core and portable command line.

## Usage

```bash
# Verify installation with synthetic shifted tile pair
stitching self-check

# Stitch a folder containing TIFF tiles and TileConfiguration.txt
stitching tiles/ results

# Stitch a 4x4 grid with 18% nominal overlap
stitching tiles/ results --layout grid --columns 4 --rows 4 --overlap 18
```

No network connection or external model files are required.
