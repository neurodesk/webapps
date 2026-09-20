# Neurodesk webapp scientific assets

Large browser-inference assets and tutorial data for the composite Neurodesk
webapps site are stored in the Hugging Face datasets
`sbollmann/neurodesk-webapps-assets` and `neurodeskorg/webapps`, not in Git.

The JSON manifests in this directory are the source of truth for filenames, byte
sizes, SHA-256 checksums, source provenance, licences, and preprocessing contracts.
Runtime URLs are pinned to an immutable Hugging Face dataset revision.

Current folders:

- `musclemap/`: six ONNX segmentation models imported from
  `neurodesk/musclemap-webapp@8b5012b`.
- `vesselboost/`: four VesselBoost models plus SynthStrip imported from
  `neurodesk/vesselboost-webapp@6ba7d07`.
- `seedseg/`: four consensus models migrated from the OSF objects recorded in
  `seedseg.manifest.json`.
- `synthseg/`: SynthSeg 2.0 ONNX re-export of the FreeSurfer 8.1.0 checkpoint
  plus validation inputs and goldens (`neurodeskorg/webapps`), see
  `synthseg.manifest.json`.
- `disconnectome/`: the 87-tract HCP1065 atlas as packed TVX for `nii2tvx` queries,
  a decimated TRX of the same tracts for display only, and three example
  lesion/T1 pairs, see `disconnectome.manifest.json`.
- `syncro/tutorials/`: seven deidentified inputs for SYNcro's four documented
  walkthroughs (`neurodeskorg/webapps`), see
  `syncro-tutorials.manifest.json` and `syncro-tutorials.README.md`.

Application and model licences are independent. `NOASSERTION` in a manifest means
the upstream project has not yet supplied machine-readable redistribution terms.
