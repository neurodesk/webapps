# @neurodesk/lcmodel

## 0.7.20261010

### Minor Changes

- Accept same-session T1 NIfTI and DICOM for offline MindMap CPU tissue correction. Measure each dataset's voxel on shared maps and save the voxel masks, maps and segmentation provenance. Share voxel geometry with the app, align MindGrab at 0.1.20260925 and check the command line against forced-CPU app downloads on the defaced Philips T1.

## 0.6.20261010

## 0.6.20261009

### Minor Changes

- e716626: Add the `lcmodel` command line. `lcmodel SPECTRUM [WATER ...] OUTPUT_DIR` runs the web app's fit operation in Node: FID-A preprocessing, the recommended or chosen basis set, and the LCModel fit, with the same WebAssembly module and every automation option. It reads the app's formats (twix, RDA, DICOM, P-file, SDAT/SPAR, NIfTI-MRS, Bruker, LCModel .RAW) and writes the app's downloads under the same names. Several datasets are fitted into the app's group tables. The app and the command line share one workflow module, so they make the same choices. Portable archives for Linux x64 and Windows x64 and a signed macOS installer include all 25 basis sets and run offline. Their release check requires every download on every example to match the web app's byte for byte. Tissue correction takes entered fractions; segmenting a T1 needs the web app until #203.

  The app's automation now applies `frequencyMHz` and `dwellTimeMs` to an LCModel .RAW; before, the file's own values replaced them as it loaded. A .RAW whose `$SEQPAR` names MEGA-PRESS is now fitted as a difference spectrum (mega-press-3 with the co-edited macromolecule model), as its recommended basis set already assumed; `edited: false` fits it as an unedited spectrum. The app version in reports now comes from the app's package.json.

## 0.3.2

### Patch Changes

- Fix NIfTI-MRS preprocessing for singleton coil and dynamic dimensions, and preserve echo and repetition times in milliseconds through fitting and export. Add an openly licensed PRESS NIfTI-MRS example with a water reference and a reproducible conversion recipe.

## 0.3.1

### Patch Changes

- 0ac9cec: Fit groups of datasets and print a report of every fit. Dropping several acquisitions, or choosing a folder of subjects, fits them one after the other with the same settings, each with its recommended basis set unless a chosen library set suits all of them or a .BASIS file was dropped. A dataset that fails, or a file that cannot be read, is listed with its error and the rest continue; the footer × stops the run and keeps the finished fits. The group table in the viewer lists each dataset's concentrations or ratios with %SD and the FID-A and LCModel quality numbers; selecting a dataset shows its fit. It downloads as a long CSV (one row per dataset and metabolite, with unit and ratio reference on every row), a wide CSV and a zip of reports. Each fit has a self-contained, printable HTML report in place of LCModel's PostScript page. Spectra in separate subject folders now pair with the water reference in their own folder, and the `fit-group` automation operation returns the group table and the reports. New example: Osprey's two-subject Philips PRESS data.

## 0.3.0

### Minor Changes

- e93c19a: GABA-edited MEGA-PRESS: FID-A's `run_megapressproc_auto` (coil combination, removal of bad averages, drift correction per subspectrum, alignment of edit-ON to edit-OFF; agrees with FID-A in GNU Octave to within 1e-7 Hz) and an LCModel fit of the difference spectrum with LCModel's MEGA-PRESS analysis (`sptype='mega-press-3'`). A new difference basis set (3 T, TE 68 ms) was simulated with FID-A's shaped 14 ms editing pulses, which reproduce the near-complete loss of the NAA singlet in the edit-ON scan that LCModel uses as its reference. The basis recommendation pairs edited data only with the difference basis and never offers it for unedited data. A Siemens MEGA-PRESS example (FID-A's, de-identified) gives GABA+/(NAA+NAAG) of 0.15 with 9 % SD; the edit-OFF spectrum is a separate download.

## 0.2.0

### Minor Changes

- bd01a6a: New app: LCModel preprocesses single-voxel MR spectroscopy with FID-A and fits it with LCModel, both as Rust ports compiled to WebAssembly. It reads Siemens twix, GE P-files, Siemens RDA and DICOM, Philips SPAR/SDAT, NIfTI-MRS, Bruker and LCModel .RAW files and pairs each spectrum with its water reference. FID-A's automatic pipelines combine coils, remove bad averages, correct drift by spectral registration and, for SPECIAL, combine the ISIS subspectra; they agree with FID-A in GNU Octave to within 10^-5 Hz. The LCModel port writes the same .TABLE and .COORD numbers as the Fortran on LCModel's test case. Nine basis sets simulated with FID-A (PRESS, STEAM, semi-LASER and SPECIAL at 1.5, 3 and 7 T) are offered; the app recommends the one that matches the data's field strength, sequence and echo time and explains any mismatch, or takes the user's own .BASIS file. Results are a fit plot, per-metabolite curves, the concentration table and downloads of the LCModel files.
