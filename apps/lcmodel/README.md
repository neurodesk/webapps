# LCModel

Single-voxel MR spectroscopy in the browser: FID-A preprocessing and LCModel
fitting, both as Rust ports compiled to WebAssembly (`packages/lcmodel`).

* Input: Siemens twix, GE P-files, Siemens RDA and DICOM, Philips SPAR/SDAT,
  NIfTI-MRS, Bruker, or an already processed LCModel `.RAW` (with an optional
  `.H2O`, control file and `.BASIS`). Files are detected and paired with their
  water reference by `exes/fida/src/io/detect.rs`.
* Preprocessing: FID-A's `run_pressproc_auto` (PRESS/STEAM/semi-LASER; GE with
  `run_pressproc_GEauto`'s phasing) or `run_specialproc_auto` (SPECIAL).
  `run_megapressproc_auto` for GABA-edited MEGA-PRESS, whose difference
  spectrum LCModel fits with `sptype='mega-press-3'`. GE and Philips files do not
  record editing: `exes/fida/src/ops/editing.rs` detects edit-ON/OFF pairs from
  the data (NAA/Cr of alternate transients), and the user can override it. Coil-combined data are
  aligned and averaged only; `.RAW` goes straight to LCModel.
* Basis sets (`models/lcmodel.manifest.json`, built by `exes/lcmodel/basis/`):
  FID-A simulations with ideal pulses (PRESS at TE 30 to 144 ms, STEAM,
  semi-LASER and SPECIAL, at 1.5, 3 and 7 T), PRESS and semi-LASER sets with
  real refocusing pulse shapes across the voxel (`-shaped`), and MEGA-PRESS
  difference sets (3 T; TE 68 and 80 ms; TE 80 ms with macromolecule
  suppression), ranked for the data by `src/basis-select.js` from its field
  strength, sequence and echo time. A shaped set ranks above the ideal set with
  the same parameters; an MM-suppressed MEGA set ranks below the standard one,
  with a warning, because no header records the edit-OFF frequency. Users can
  drop their own `.BASIS` (plain or gzipped) in the basis section or with the
  data.
* GABA and co-edited macromolecules: MEGA-PRESS difference spectra are fitted
  from 4.2 to 0.5 ppm, leaving out 1.2-1.95 ppm as Osprey's MEGA-PRESS LCModel
  jobs do (PPMGAP), with two LCModel simulated components, MM09 (0.915 ppm)
  and MM3co (3.0 ppm, 14 Hz, 2 protons), tied by the soft constraint
  MM3co/MM09 = 1 ± 0.2 (Zöllner et al., NMR Biomed 2022;35:e4618, "MM09soft").
  The table reports GABA, MM3co and GABA+MM3co (GABA+), each with %SD. GABA+
  is robust; separating GABA from MM3co relies on the model's assumptions
  (MM3co line width, its ratio to MM09), and the split moves when they move.
  On the examples, relative to NAA+NAAG: Siemens GABA 0.075 (17 %), MM3co 0.216
  (11 %), GABA+ 0.291 (7 %); Philips GABA 0.102 (14 %), MM3co 0.191 (9 %),
  GABA+ 0.293 (5 %). GABA is 26 % and 35 % of GABA+, against the ~50 % usually
  assumed. Fitted through 1.2-1.95 ppm, a broad signal there stays unmodelled
  (largest on Philips: positive at 1.3-1.6 ppm, negative near 1.1 ppm,
  residual RMS 3.1 % of the NAA peak; nothing in the model represents the
  macromolecules and lipids the editing pulse hits there, and mega-press-3
  has no baseline). Leaving it out changes GABA+ by 1 % but moves the Philips
  split from 0.131/0.165 to 0.102/0.191. GABA+ is higher than what a GABA-only fit (no MM model, 4.2 to
  1.95 ppm) reported (0.153 and 0.241, so 1.9 and 1.2 times): that fit leaves
  the broad co-edited signal at 3 ppm in the residual, as Zöllner et al. found.
  The co-edited model is the default; LCModel settings keep that previous
  analysis as macromolecule model "none" (automation parameter
  `macromoleculeModel`), which reproduces 0.153 and 0.241. The fit range
  follows the model unless the user typed one. MM-suppressed sets always use
  "none". The table and CSV lead with GABA+; GABA and MM3co carry a
  model-dependent note (CSV column `Note`, `measurements.metabolites[].note`),
  and the automation provenance records `macromoleculeModel`.
* Line-broadening prior (`LINE_BROADENING` in `src/lcmodel-io.js`): unedited
  fits use DESDT2 = 2 and RFWBAS = 80 by default ("widened"). The library's
  basis sets have 1.5 Hz Lorentzian lines. With LCModel's defaults (DESDT2 0.4,
  RFWBAS 10) the fit cannot follow the broadened Lorentzian tails and the
  reference singlet is integrated over +-5 basis linewidths only, so
  water-scaled concentrations come out 13 % low on synthetic spectra of known
  concentration (`test/water-scaling.test.js`, also in the `lcmodel-native` CI
  job) and 8-15 % below spant's ABfit with the same basis on the same real
  PRESS files (`exes/lcmodel/tools/spant_water_scaled.R`, PR #120). Widened
  recovers the synthetic concentrations to 1 % and agrees with spant to about
  5 %. It applies with or without a water reference, so ratios and absolute
  values come from the same fit. On the unedited examples it raises
  water-scaled Cr+PCr by 9-22 % and NAA+NAAG by 5-16 %, moves NAA+NAAG/Cr+PCr
  by 3-7 %, and raises no %SD below 20 % by more than 6 points (Ins on Philips
  sub-02, 7 to 13 %); LCModel adds no warnings, only an informational
  FINOUT 9 on two fits. MEGA-PRESS difference
  fits keep LCModel's values: there the widened prior moved GABA+/NAA+NAAG by
  +16 % (Siemens) and +31 % (Philips) and Philips' water-scaled NAA+NAAG by
  -27 %, with nothing to validate it for the mega-press-3 analysis, so the
  setting is disabled for edited data. "LCModel defaults" (automation
  `lineBroadening: "lcmodel"`) matches other LCModel analyses and reproduces
  LCModel's test case exactly. The control file, the provenance, the report and
  the group CSV record the prior used.
* Output: fit, metabolite and preprocessing plots (`src/spectrum-plot.js`), the
  concentration table, and downloads of the concentrations (.csv), LCModel's
  `.table`/`.coord`, the `.RAW`/`.H2O`, the control file and FID-A's report.
* Report: LCModel's PostScript page is not ported (`lps=0`); `src/report.js`
  writes a self-contained HTML report per fit instead (inline SVG plots, its own
  print CSS, no external resources): fit, concentration table with %SD above
  20 % marked, diagnostics, header, FID-A summary, basis set and checksum,
  control file and versions. View opens it in a tab for printing to PDF.
* Groups: several datasets (a folder of subjects; `detect.rs` pairs each
  spectrum with the water reference closest in the folder tree) are fitted one
  after the other by "Fit all N datasets". Basis per dataset (`planBases` in
  `src/group.js`): a dropped .BASIS fits all; a library set picked over the
  recommendation fits all if it suits all; otherwise each dataset gets its own
  recommendation. Failures and unreadable files become failed rows; the run
  continues. The group table (`src/group-view.js`) sits in the viewer's Group
  tab. The primary CSV is long (dataset x metabolite rows), because unit (mM or
  a.u.) and ratio reference (Cr+PCr, NAA+NAAG) can differ per dataset; a wide
  CSV and a zip of reports are also offered. Every row also carries the
  macromolecule model, the line-broadening prior, and, for a corrected
  dataset, the tissue fractions, their source and the tissue- and
  alpha-corrected concentrations (`SETTING_COLUMNS`, `METABOLITE_FIELDS`); the
  Group tab can show the corrected values. MEGA-PRESS datasets in a group
  follow the macromolecule model setting. Automation: `fit-group`.

* Tissue correction (optional, `src/tissue-panel.js`): the voxel geometry comes
  from the header (`exes/fida/src/io/geometry.rs`: twix, Siemens DICOM, RDA,
  SPAR, NIfTI-MRS; spec2nii's conventions, checked against spec2nii). A T1 from
  the same session (NIfTI, or DICOM through the shared dcm2niix import) is
  segmented with MindMap's partial-volume maps (`@brainchop/mindgrab`
  `segmentTissues`; WebGPU, hardware WebGL2, else the threaded CPU module).
  `src/voxel.js` samples the oblique voxel box on the T1 grid (5 x 5 x 5 points
  per T1 voxel) for Osprey-style fractions; the Voxel view draws it on the T1.
  `src/tissue.js` is Osprey's `quantTiss`/`quantAlpha` (Gasparovic 2006, Harris
  2015) on LCModel's water-scaled output, tested against Osprey's own code in
  Octave. Fractions can also be typed in. GE, Bruker and .RAW carry no voxel
  position here. In a group, a loaded T1 is taken to be the session's: the run
  measures each dataset's own voxel on it. Typed fractions describe one voxel,
  so they correct only the dataset on display. Under the co-edited MM model,
  GABA+ (GABA+MM3co) is alpha-corrected as Osprey's GABAplus.

Examples (Hugging Face `neurodeskorg/webapps`, `lcmodel/examples/`): FID-A's GE
PRESS phantom (3 T, TE 35 ms), FID-A's Siemens SPECIAL in vivo data (2.89 T,
TE 8.5 ms, 178 MB) and MEGA-PRESS data (TE 68 ms, 86 MB), headers de-identified,
Osprey's Philips MEGA-PRESS data (SDAT, TE 68 ms, MIT), Osprey's Philips PRESS
data of two subjects (TE 35 ms, MIT, the group example), Osprey's Philips PRESS
sub-01 (TE 35 ms) with its T1, defaced with the Deface app's
`niimath -deface avg152T1 avg152T1mask` (the published T1 has no face), and LCModel's synthetic test case,
whose table the app reproduces exactly (`e2e/smoke.spec.js`).

The NIfTI-MRS PRESS example uses Osprey's MIT-licensed Philips PRESS sub-01
data at 3 T and TE 35 ms, with its water reference. The files were converted
with spec2nii 0.8.12 and de-identified. Their immutable dataset revision is
`2a18766f2c4b5c9086e3512cd6f2a56841da9a4f`; the dataset directory contains
the license and provenance. The conversion script adds `SequenceName=PRESS`
from the source's preserved `ProtocolName=PRESS PAR 35` so the app can
recommend the correct sequence family. `tools/convert_nifti_mrs_example.py` reproduces
the published files from checksummed sources. Install `spec2nii==0.8.12`
and `nibabel==5.4.2` in a scratch environment, then run:

```bash
TMPDIR=/storage/tmp python tools/convert_nifti_mrs_example.py /storage/tmp/nifti-mrs-press
```

NIfTI-MRS echo and repetition times are seconds in the file. The app
normalizes them to milliseconds before preprocessing and LCModel export.
Tagged dimensions of size one do not count as coils or averages.

```bash
pnpm --filter lcmodel test        # basis selection, LCModel file parsing, plots, group table, report
pnpm --filter lcmodel test:e2e    # browser workflow; LCMODEL_E2E_LARGE=1 adds SPECIAL and MEGA-PRESS
```
