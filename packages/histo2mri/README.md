# `@neurodesk/histo2mri`

2D histology section to 3D MRI registration (Greedy NMI rigid, affine, plane offset/tilt search and deformable SVF warp) core and portable command line.

## Usage

```bash
# Verify installation and Greedy single-threaded WASM runtime
histo2mri self-check

# Register a histology section (TIFF, PNG or JPEG) to coronal slice 50 of a 3D MRI
histo2mri mri.nii.gz section.tif results --axis 2 --slice 50

# Register a stack of consecutive sections 2 slices apart, linear only
histo2mri mri.nii.gz sec01.png sec02.png results --axis 2 --slice 48 --step 2 --no-deformable
```

No network connection or external model files are required.
