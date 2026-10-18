# lcmodel

## 0.8.20261018

### Patch Changes

- Updated dependencies [67a5a8f]
- Updated dependencies [b8b37d6]
- Updated dependencies [2ae93ae]
- Updated dependencies [ccb2970]
- Updated dependencies [67a5a8f]
  - @neurodesk/runtime-support@0.7.0
  - @neurodesk/webapp-components@0.14.4
  - @neurodesk/lcmodel@0.8.20261018

## 0.8.20261017

### Patch Changes

- Updated dependencies [b547d52]
  - @neurodesk/webapp-components@0.14.3
  - @neurodesk/lcmodel@0.8.20261017
  - @neurodesk/runtime-support@0.6.4

## 0.8.20261016

### Patch Changes

- Persist checksum-verified model and example caches across browser restarts. Bind runtime caches to each document’s checksum manifest to avoid reusing bytes from a different deployment.
- Updated dependencies
  - @neurodesk/webapp-components@0.14.2
  - @neurodesk/runtime-support@0.6.3
  - @neurodesk/lcmodel@0.8.20261016
- Updated dependencies [7443048]
  - @neurodesk/webapp-components@0.14.1
  - @neurodesk/lcmodel@0.8.20261016
  - @neurodesk/runtime-support@0.6.2

## 0.8.20261015

### Patch Changes

- Updated dependencies [c74b26f]
  - @neurodesk/runtime-support@0.6.1
  - @neurodesk/lcmodel@0.8.20261015
- e59305a: A Siemens session folder that holds the averaged (`_ave`) and unaveraged series of one acquisition beside its water-unsuppressed (`_water_off`) series now pairs that water reference with both spectra. Before, the second spectrum stopped the folder pairing, so the spectrum was fitted without water and the water series was listed as unpaired. The water series pairs only with spectra of the same study and protocol (series description without the series number and suffix).

  Series prefixes are checked against DICOM SeriesNumber or the supported
  `sub-SUBJECT-SERIES-` folder convention, preserving numeric protocol parameters.
  Sharing refuses different known VOI geometry. Missing geometry leaves a
  protocol-matching heuristic; the site's private acquisition has not been tested.

- Updated dependencies [e59305a]
  - @neurodesk/lcmodel@0.8.20261015
- dd65e6a: Visual refresh: Inter, neutral greys with the Neurodesk logo green for action,
  focus and selection only, a compact 48px app bar, sentence-case section titles
  and a quieter status bar. The example menu is now the input control: examples,
  then Choose files… and Choose folder…. The whole window, the viewer included,
  accepts dropped files; a drop mid-session replaces the inputs with Undo in the
  status bar. Before any input the status reads "Drag and drop files". MuscleMap
  drops its separate drop box and Add File(s) button.

  Page drops fill empty image slots in order while keeping DICOM series together.
  New selections supersede unfinished drop traversal, and registration apps load
  each dropped image in order. The shared drop handler also respects the different
  native input and file-field event contracts.
  Failed imports leave only successfully loaded slots occupied, and Undo can
  restore loaded examples.

- Updated dependencies [0569da8]
- Updated dependencies [dd65e6a]
- Updated dependencies [dcc74e7]
  - @neurodesk/runtime-support@0.6.0
  - @neurodesk/webapp-components@0.14.0
  - @neurodesk/lcmodel@0.8.20261015

## 0.8.20261014

### Patch Changes

- fc978bd: A user's basis file without a field strength or echo time is now named as the file missing it, instead of saying the data do not record it.
- Updated dependencies [fc978bd]
- Updated dependencies [27c9549]
- Updated dependencies [850e642]
- Updated dependencies [ad92e2f]
  - @neurodesk/lcmodel@0.8.20261014
  - @neurodesk/runtime-support@0.5.0
  - @neurodesk/webapp-components@0.13.0

## 0.8.20261013

### Patch Changes

- Keep accompanying anatomical images optional when importing spectroscopy folders. Skip unusable images with a warning, offer None when choosing a series, and clear previous anatomy when skipping. Automation uses only its explicit T1 input and never waits for the graphical series chooser.
  - @neurodesk/lcmodel@0.8.20261013
- Invalidate measured tissue correction and map downloads when replacement anatomy is adopted, before waiting for viewer presentation.
  - @neurodesk/lcmodel@0.8.20261013
- 36d64d0: Reject imports that mix LCModel RAW and vendor spectra before replacing the current session or fit. Continue allowing RAW spectra with anatomical images.
  - @neurodesk/lcmodel@0.8.20261013
- Finish the progress indicator and hide cancellation when automation preparation fails. Show the input error or Cancelled while preserving the loaded session.
- Updated dependencies
  - @neurodesk/lcmodel@0.8.20261013

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
- Updated dependencies [5cc60db]
- Updated dependencies
- Updated dependencies
  - @neurodesk/lcmodel@0.8.20261012
  - @neurodesk/webapp-components@0.12.3
  - @neurodesk/runtime-support@0.4.3
- Updated dependencies
  - @neurodesk/lcmodel@0.8.20261012

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
- Updated dependencies [8321cb9]
  - @neurodesk/lcmodel@0.7.20261012
- 1ce9fe7: Fix three failures reported from multi-site data:

  - Water references pair with `<stem>_act` and `<stem>_ws` spectra in every format, not only SDAT/SPAR, so spec2nii's conversions of Philips data (`_act`/`_ref`) are water-scaled. `_water_off` and `_nows` name a water reference. Unmatched Siemens DICOM series pair only when there is one spectrum and one water series in the folder, their nonempty StudyInstanceUIDs match, and their recorded PatientIDs do not disagree. Unmatched single-file inputs stay separate. DICOM series without spectroscopy data are skipped instead of counted as datasets.
  - NIfTI-MRS converted from GE data (`Manufacturer` GE) is phased on the residual water as GE P-files are (`run_pressproc_GEauto`), instead of being left about 60 degrees out of phase.
  - When MindMap fails on the GPU, the technical log shows the module's own output and the voxel is segmented on the CPU instead.

- Updated dependencies [1ce9fe7]
  - @neurodesk/lcmodel@0.7.20261012

## 0.7.20261010

### Minor Changes

- Accept same-session T1 NIfTI and DICOM for offline MindMap CPU tissue correction. Measure each dataset's voxel on shared maps and save the voxel masks, maps and segmentation provenance. Share voxel geometry with the app, align MindGrab at 0.1.20260925 and check the command line against forced-CPU app downloads on the defaced Philips T1.

### Patch Changes

- Updated dependencies
  - @neurodesk/webapp-components@0.12.2
  - @neurodesk/runtime-support@0.4.2
  - @neurodesk/lcmodel@0.7.20261010
- Updated dependencies
  - @neurodesk/lcmodel@0.7.20261010
  - @neurodesk/runtime-support@0.4.1
  - @neurodesk/webapp-components@0.12.1

## 0.6.20261010

### Patch Changes

- Updated dependencies
  - @neurodesk/runtime-support@0.4.1
  - @neurodesk/webapp-components@0.12.1
  - @neurodesk/lcmodel@0.6.20261010

## 0.6.20261009

### Minor Changes

- e716626: Add the `lcmodel` command line. `lcmodel SPECTRUM [WATER ...] OUTPUT_DIR` runs the web app's fit operation in Node: FID-A preprocessing, the recommended or chosen basis set, and the LCModel fit, with the same WebAssembly module and every automation option. It reads the app's formats (twix, RDA, DICOM, P-file, SDAT/SPAR, NIfTI-MRS, Bruker, LCModel .RAW) and writes the app's downloads under the same names. Several datasets are fitted into the app's group tables. The app and the command line share one workflow module, so they make the same choices. Portable archives for Linux x64 and Windows x64 and a signed macOS installer include all 25 basis sets and run offline. Their release check requires every download on every example to match the web app's byte for byte. Tissue correction takes entered fractions; segmenting a T1 needs the web app until #203.

  The app's automation now applies `frequencyMHz` and `dwellTimeMs` to an LCModel .RAW; before, the file's own values replaced them as it loaded. A .RAW whose `$SEQPAR` names MEGA-PRESS is now fitted as a difference spectrum (mega-press-3 with the co-edited macromolecule model), as its recommended basis set already assumed; `edited: false` fits it as an unedited spectrum. The app version in reports now comes from the app's package.json.

### Patch Changes

- Updated dependencies [66bf9e9]
- Updated dependencies [501ea0c]
- Updated dependencies [e716626]
- Updated dependencies [64ffefa]
  - @neurodesk/webapp-components@0.12.0
  - @neurodesk/lcmodel@0.6.20261009
  - @neurodesk/runtime-support@0.3.0

## 0.5.20261007

### Patch Changes

- Updated dependencies [22aa4bf]
  - @neurodesk/webapp-components@0.11.1
  - @neurodesk/runtime-support@0.2.1
- Updated dependencies
  - @neurodesk/webapp-components@0.11.0
  - @neurodesk/runtime-support@0.2.0
- Fix NIfTI-MRS preprocessing for singleton coil and dynamic dimensions, and preserve echo and repetition times in milliseconds through fitting and export. Add an openly licensed PRESS NIfTI-MRS example with a water reference and a reproducible conversion recipe.
- Updated dependencies
  - @neurodesk/lcmodel@0.3.2
- Updated dependencies [70f2770]
  - @neurodesk/webapp-components@0.10.2

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
