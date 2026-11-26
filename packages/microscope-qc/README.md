# `@neurodesk/microscope-qc`

Microscope quality control (bead PSF FWHM and field illumination uniformity following MetroloJ_QC) core and portable command line.

## Usage

```bash
# Verify installation with synthetic Gaussian bead phantom
microscope-qc self-check

# Run PSF bead analysis on a calibrated OME-TIFF z-stack
microscope-qc evos-40x-na095-tetraspeck-100nm.ome.tif results

# Run field illumination QC on a 2D uniform fluorescent slide image
microscope-qc slide.ome.tif results --analysis field
```

No network connection or external model files are required.
