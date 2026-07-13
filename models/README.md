# Neurodesk webapp scientific assets

Large browser-inference assets for the composite Neurodesk webapps site are stored
in the Hugging Face dataset `sbollmann/neurodesk-webapps-assets`, not in Git.

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

Application and model licences are independent. `NOASSERTION` in a manifest means
the upstream project has not yet supplied machine-readable redistribution terms.
