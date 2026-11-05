---
"microscope-qc": minor
---

Add Microscope QC, a browser app for light-microscope quality control with MetroloJ_QC's definitions. PSF from beads detects sub-resolution beads in a z-stack by prominence, fits ImageJ's Gaussian to their x, y and z profiles and reports FWHM per bead and summarised against the theoretical resolution; field illumination reports uniformity, field uniformity, centering accuracy, profiles and iso-intensity zones. Optics and voxel size come from OME-XML when recorded. On the 100 nm bead example the FWHMs equal MetroloJ_QC's own fitter in Fiji to 1e-6, and the field metrics equal the ImageJ reference.
