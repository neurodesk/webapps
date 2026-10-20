# dcm2niix

Convert one scanner MRI examination to a reviewed BIDS 1.11.2 dataset locally
in the browser. Select DICOM files, a folder or ZIP archives. The app uses the
shared `@neurodesk/runtime-support/dcm2niix-client` worker and keeps every
image, JSON sidecar and diffusion gradient file paired by output stem.

After conversion, enter a dataset name and alphanumeric subject/session labels.
Choose T1w, T2w, FLAIR, DWI, reverse DWI or Exclude for each acquisition. Any
subset is accepted. Review metadata, supply missing values, then confirm each
included acquisition. Changes invalidate its confirmation and any prior export.
Separate acquisitions remain separate; repeated filenames receive run indices.
The app neither merges acquisitions nor runs preprocessing.

Reverse b=0 acquisitions export as `fmap/*_dir-*_epi`; full reversed diffusion
acquisitions stay in `dwi/` with their gradients. Choose the DWI each fieldmap
serves and enter opposing phase encoding directions and total readout times.
The output records `B0FieldIdentifier`, `B0FieldSource` and BIDS-URI `IntendedFor`
relationships. Filename direction labels are user labels; JSON directions refer
to NIfTI voxel axes. Do not derive them from AP/PA names alone.

DWI export requires one b-value and one vector per volume, with vectors in
NIfTI/FSL coordinates. Missing gradients can be loaded or pasted in the metadata
editor. Geometry and gradient ordering are preserved; the app never fabricates
vectors. Phase, real and imaginary components are outside the supported subset.

Every export requires an explicit metadata privacy choice. Omit mode keeps a
technical-field allowlist, clears NIfTI text/extensions and omits identifiers,
dates, protocol names and unknown vendor fields. Retain mode preserves original
converted metadata. Images are not defaced in either mode. Input data and labels
are never persisted or uploaded; public examples alone may use the shared cache.
Inputs are limited to 2 GiB and browser memory may impose a lower limit.

The ZIP includes `dataset_description.json`, README, `participants.tsv` and the
subject/session tree. Checks cover this app's supported BIDS subset; they do not
replace validation with the official BIDS validator.

Development follows the app template:

```sh
pnpm --filter dcm2niix dev
pnpm --filter dcm2niix test
pnpm --filter dcm2niix build
pnpm --filter dcm2niix test:e2e
```

`src/input.js` adapts files/archives and checks examination identity using the
shared DICOM reader. `src/bids.js` contains DOM-independent output pairing,
validation, metadata filtering, naming and export. `src/review.js` renders the
editable review; `src/main.js` connects it to shared shell, status and automation.
No app-specific stylesheet or image viewer is required.
