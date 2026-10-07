# lcmodel

## 0.5.20261007

### Patch Changes

- Fix NIfTI-MRS preprocessing for singleton coil and dynamic dimensions, and preserve echo and repetition times in milliseconds through fitting and export. Add an openly licensed PRESS NIfTI-MRS example with a water reference and a reproducible conversion recipe.
- Updated dependencies
  - @neurodesk/lcmodel@0.3.2

## 0.5.20261005

### Patch Changes

- Shade the ppm window a MEGA-PRESS fit leaves out (1.95-1.2 ppm with the co-edited macromolecule model) and label it "not fitted", and draw the data through it. LCModel writes no points there, so the app rebuilds that stretch from the .RAW file it fitted, with LCModel's shift and phase, and leaves it empty if the rebuild does not reproduce LCModel's data.

## 0.5.20261004

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.10.1
- Updated dependencies [0204fe1]
- Updated dependencies [ec85a09]
  - @neurodesk/webapp-components@0.10.0
- Updated dependencies [257192b]
  - @neurodesk/runtime-support@0.1.3
- Updated dependencies
  - @neurodesk/webapp-components@0.9.0

## 0.5.20261003

### Minor Changes

- The sidebar results table fits its four columns: a select switches the last one between the ratio and the tissue-corrected value, and long combination names wrap after "+". Typing a tissue fraction and clicking a Download button straight away no longer loses the click: the shared result list keeps unchanged rows when it re-renders.

- dd05295: Separate GABA from co-edited macromolecules in MEGA-PRESS fits, and add basis sets. By default the fit now models the macromolecule signal at 3.0 ppm (MM3co) that GABA editing co-edits, tied to the macromolecule peak at 0.915 ppm as Zöllner et al. (2022) recommend, fits edited data from 4.2 to 0.5 ppm without 1.2 to 1.95 ppm (as Osprey does), and reports GABA, MM3co and GABA+ with %SD. Results lead with GABA+, the robust number; GABA and MM3co are marked as model-dependent in the table and the CSV. The previous analysis (LCModel's mega-press-3, 4.2 to 1.95 ppm, GABA reported as GABA+) stays available as the macromolecule model "None" in the LCModel settings and as the automation parameter `macromoleculeModel`. New basis sets: MEGA-PRESS at TE 80 ms, with and without macromolecule suppression (edit-OFF at 1.5 ppm, always fitted without MM3co), and PRESS and semi-LASER sets simulated with real refocusing pulse shapes across the voxel, which the app now prefers to the ideal-pulse set with the same parameters.
- 0ac9cec: Fit groups of datasets and print a report of every fit. Dropping several acquisitions, or choosing a folder of subjects, fits them one after the other with the same settings, each with its recommended basis set unless a chosen library set suits all of them or a .BASIS file was dropped. A dataset that fails, or a file that cannot be read, is listed with its error and the rest continue; the footer × stops the run and keeps the finished fits. The group table in the viewer lists each dataset's concentrations or ratios with %SD and the FID-A and LCModel quality numbers; selecting a dataset shows its fit. It downloads as a long CSV (one row per dataset and metabolite, with unit and ratio reference on every row), a wide CSV and a zip of reports. Each fit has a self-contained, printable HTML report in place of LCModel's PostScript page. Spectra in separate subject folders now pair with the water reference in their own folder, and the `fit-group` automation operation returns the group table and the reports. New example: Osprey's two-subject Philips PRESS data.
- a5c4f7d: Fit unedited spectra with a widened line-broadening prior (DESDT2 2, RFWBAS 80) by default. With the app's narrow-line FID-A basis sets, LCModel's default priors scale water-referenced concentrations 8-15 % low: 13 % below the known concentrations of synthetic spectra, and below spant's ABfit with the same basis on the same files. The widened prior recovers the synthetic concentrations to 1 % and agrees with spant within about 5 %; it applies with or without a water reference, so ratios and concentrations come from the same fit. MEGA-PRESS difference fits keep LCModel's values. "LCModel defaults" in the LCModel settings, and the automation parameter `lineBroadening`, restore LCModel's own priors. Groups, reports and fits now work together: the group table, both group CSVs and the printable report record the macromolecule model, the line-broadening prior and, when a dataset was corrected, its tissue fractions and tissue-corrected concentrations; MEGA-PRESS datasets in a group follow the macromolecule model setting; a group run with a T1 measures each dataset's own voxel on it; and GABA+ is alpha-corrected under the co-edited macromolecule model.
- 030dfcb: Add tissue-corrected concentrations. The readers now take the voxel's position, size and orientation from Siemens twix, DICOM and RDA, Philips SPAR and NIfTI-MRS headers (spec2nii's conventions). An optional T1 from the same session is segmented in the browser with MindMap's partial-volume maps, the voxel is drawn on it in a new Voxel view, and its grey matter, white matter and CSF fractions, or fractions typed in from another tool, correct the water-scaled concentrations as in Gasparovic et al. 2006 with Osprey's constants (alpha-corrected GABA and Glx for edited data). The table gains a tissue-corrected column; downloads add the corrected CSV, the inputs as JSON, the voxel mask and the tissue maps. A new example pairs Osprey's Philips PRESS data with its defaced T1.

### Patch Changes

- Updated dependencies

  - @neurodesk/webapp-components@0.8.0

- Updated dependencies [0ac9cec]
  - @neurodesk/lcmodel@0.3.1

## 0.4.20261003

### Minor Changes

- Edited MEGA-PRESS from GE P-files and Philips SDAT. Neither format records editing, so the app compares alternate transients (the editing pulse nearly erases NAA in edit-ON), splits them into edit-OFF and edit-ON, and runs FID-A's MEGA-PRESS pipeline; a switch under the dataset overrides the detection. The Philips path matches FID-A run in Octave. Adds Osprey's Philips MEGA-PRESS example. The basis section now has a visible drop zone for your own .BASIS file, and a user basis that names no sequence can be used for edited data, with a warning.

## 0.3.20261002

### Minor Changes

- Six more FID-A basis sets: PRESS at 1.5 T (TE 35 and 144 ms), STEAM at 1.5 T (TE 20 ms), and at 3 T PRESS TE 80 ms, STEAM TE 8 ms and semi-LASER TE 35 ms. The library now has fifteen sets plus the MEGA-PRESS difference set, and the recommendation picks among them. The app also publishes a typed automation contract (`fit`): preprocess and fit with a library or supplied basis set, returning the concentrations, LCModel's outputs and FID-A's report.

## 0.2.20261002

### Minor Changes

- e93c19a: GABA-edited MEGA-PRESS: FID-A's `run_megapressproc_auto` (coil combination, removal of bad averages, drift correction per subspectrum, alignment of edit-ON to edit-OFF; agrees with FID-A in GNU Octave to within 1e-7 Hz) and an LCModel fit of the difference spectrum with LCModel's MEGA-PRESS analysis (`sptype='mega-press-3'`). A new difference basis set (3 T, TE 68 ms) was simulated with FID-A's shaped 14 ms editing pulses, which reproduce the near-complete loss of the NAA singlet in the edit-ON scan that LCModel uses as its reference. The basis recommendation pairs edited data only with the difference basis and never offers it for unedited data. A Siemens MEGA-PRESS example (FID-A's, de-identified) gives GABA+/(NAA+NAAG) of 0.15 with 9 % SD; the edit-OFF spectrum is a separate download.

### Patch Changes

- Updated dependencies [e93c19a]
  - @neurodesk/lcmodel@0.3.0

## 0.1.20260930

### Minor Changes

- bd01a6a: New app: LCModel preprocesses single-voxel MR spectroscopy with FID-A and fits it with LCModel, both as Rust ports compiled to WebAssembly. It reads Siemens twix, GE P-files, Siemens RDA and DICOM, Philips SPAR/SDAT, NIfTI-MRS, Bruker and LCModel .RAW files and pairs each spectrum with its water reference. FID-A's automatic pipelines combine coils, remove bad averages, correct drift by spectral registration and, for SPECIAL, combine the ISIS subspectra; they agree with FID-A in GNU Octave to within 10^-5 Hz. The LCModel port writes the same .TABLE and .COORD numbers as the Fortran on LCModel's test case. Nine basis sets simulated with FID-A (PRESS, STEAM, semi-LASER and SPECIAL at 1.5, 3 and 7 T) are offered; the app recommends the one that matches the data's field strength, sequence and echo time and explains any mismatch, or takes the user's own .BASIS file. Results are a fit plot, per-metabolite curves, the concentration table and downloads of the LCModel files.

### Patch Changes

- Updated dependencies [bd01a6a]
  - @neurodesk/lcmodel@0.2.0
