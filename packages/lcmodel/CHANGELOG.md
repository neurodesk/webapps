# @neurodesk/lcmodel

## 0.8.20261018

### Patch Changes

- Updated dependencies [2ae93ae]
- Updated dependencies [ccb2970]
- Updated dependencies [67a5a8f]
  - @neurodesk/webapp-components@0.14.4

## 0.8.20261017

### Patch Changes

- Updated dependencies [b547d52]
  - @neurodesk/webapp-components@0.14.3

## 0.8.20261016

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.14.2
- Updated dependencies [7443048]
  - @neurodesk/webapp-components@0.14.1

## 0.8.20261015

### Patch Changes

- e59305a: A Siemens session folder that holds the averaged (`_ave`) and unaveraged series of one acquisition beside its water-unsuppressed (`_water_off`) series now pairs that water reference with both spectra. Before, the second spectrum stopped the folder pairing, so the spectrum was fitted without water and the water series was listed as unpaired. The water series pairs only with spectra of the same study and protocol (series description without the series number and suffix).

  Series prefixes are checked against DICOM SeriesNumber or the supported
  `sub-SUBJECT-SERIES-` folder convention, preserving numeric protocol parameters.
  Sharing refuses different known VOI geometry. Missing geometry leaves a
  protocol-matching heuristic; the site's private acquisition has not been tested.

- Updated dependencies [dd65e6a]
- Updated dependencies [dcc74e7]
  - @neurodesk/webapp-components@0.14.0

## 0.8.20261014

### Patch Changes

- fc978bd: A user's basis file without a field strength or echo time is now named as the file missing it, instead of saying the data do not record it.
- Updated dependencies [27c9549]
- Updated dependencies [850e642]
- Updated dependencies [ad92e2f]
  - @neurodesk/webapp-components@0.13.0

## 0.8.20261013

### Patch Changes

- Finish the progress indicator and hide cancellation when automation preparation fails. Show the input error or Cancelled while preserving the loaded session.

## 0.8.20261012

### Minor Changes

- Show anatomical images immediately and display the tissue segmentation with the spectroscopy voxel. Add a separate water-reference upload for the selected dataset, preserve usable data after failed imports, and separate anatomical and spectroscopy series in mixed session folders. Load the image viewer with the page to avoid a deferred module fetch after a deployment.

### Patch Changes

- 5cc60db: Messages that let a site diagnose a failure from the technical log alone:

  - Every loaded dataset logs the parameters the fit relies on (sequence, field,
    TE, TR) and where its voxel is, or, for a GE P-file whose header does not
    make a voxel box, the header values it was built from.
  - A DICOM folder without a spectrum is reported once, with what it is
    (series, description, modality, image type, storage class, pixel data).
  - LCModel's diagnostics are explained: MYBASI 10 names the basis set's and
    the data's echo times; information lines say the fit is unaffected.
  - Tissue correction logs the T1's data type, scaling and qform/sform codes,
    the browser and WebGPU adapter, and why a large T1 goes to the CPU.

- Reject fit requests without spectroscopy from the supplied inputs before changing a loaded session. Preserve editing overrides and acquisition metadata when adding RAW water references. Keep invalid or cancelled interactive uploads and automation requests from replacing resident inputs, settings or downloads. Display anatomy and tissue images from the Results sidebar and retain independent voxel visibility.
- Updated dependencies
  - @neurodesk/webapp-components@0.12.3

## 0.7.20261012

### Patch Changes

- Cache Siemens DICOM study and patient identifiers once per dataset during water pairing. Repeated subject names keep the same identity checks without reparsing spectroscopy data for every candidate.
- b968db1: Siemens VE spectroscopy DICOMs whose `(7FE1,1010)` element has no
  `SIEMENS CSA NON-IMAGE` private-creator label are recognised as spectra
  again, as the reader always accepted them.
- 8321cb9: Tissue correction now works for GE P-files and for high-resolution T1 images.

  - GE P-files record the voxel: its centre and size (`user8-13`) and the
    prescription plane (`tlhc`, `trhc`, `brhc`) in the image header. The reader
    now builds the voxel affine from them as spec2nii does, so a GE dataset can
    be segmented and measured on its T1 instead of reporting that the format
    does not record where the voxel is.
  - MindMap's WebGPU and WebGL2 modules have a fixed 768 MiB heap and ran out of
    memory on T1s larger than its 256³ grid (0.8 mm isotropic, GE's 512 x 512
    BRAVO), which surfaced as "the mindmap module exited cleanly but wrote no
    output". Those T1s now segment on the threaded CPU module, and a failed GPU
    run is retried there.
  - Philips spectra converted to NIfTI-MRS by spec2nii keep their `_act` and
    `_ref` names; the water reference now pairs with its spectrum in every
    format, not only SDAT/SPAR, so these datasets are water-scaled and can be
    tissue-corrected.

- Reject named Siemens DICOM water candidates when recorded study or patient identifiers conflict. Explicit filename matches remain available when identifiers are absent; arbitrary-series fallback still requires the same nonempty StudyInstanceUID. Limit the GE residual-water phasing description to multi-coil, unedited data processed by the PRESS pipeline.
- Classify Philips SDAT water references with the shared naming rule. `_water_off`, `_nows`, `_wref` and `_h2o` now pair with their spectrum instead of being loaded as additional metabolite datasets.
- 1ce9fe7: Fix three failures reported from multi-site data:

  - Water references pair with `<stem>_act` and `<stem>_ws` spectra in every format, not only SDAT/SPAR, so spec2nii's conversions of Philips data (`_act`/`_ref`) are water-scaled. `_water_off` and `_nows` name a water reference. Unmatched Siemens DICOM series pair only when there is one spectrum and one water series in the folder, their nonempty StudyInstanceUIDs match, and their recorded PatientIDs do not disagree. Unmatched single-file inputs stay separate. DICOM series without spectroscopy data are skipped instead of counted as datasets.
  - NIfTI-MRS converted from GE data (`Manufacturer` GE) is phased on the residual water as GE P-files are (`run_pressproc_GEauto`), instead of being left about 60 degrees out of phase.
  - When MindMap fails on the GPU, the technical log shows the module's own output and the voxel is segmented on the CPU instead.

## 0.7.20261010

### Minor Changes

- Accept same-session T1 NIfTI and DICOM for offline MindMap CPU tissue correction. Measure each dataset's voxel on shared maps and save the voxel masks, maps and segmentation provenance. Share voxel geometry with the app, align MindGrab at 0.1.20260925 and check the command line against forced-CPU app downloads on the defaced Philips T1.

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.12.2

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
