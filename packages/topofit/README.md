# TopoFit

Browser packaging for BrainNet TopoFit 0.5.1. The package preserves the pinned
OpenRecon workflow's TReGA alignment, order-6 cortical topology, bilateral
white/pial/registration surfaces, and source-grid QC output.

The model release is external. Create a Python 3.11 environment from
`requirements-export.txt`, then run:

```bash
python scripts/export_models.py /path/to/topofit-release
python scripts/publish_release.py /path/to/topofit-release
python scripts/activate_manifest.py /path/to/topofit-release HUGGING_FACE_COMMIT model.manifest.json
```

The exporter validates every learned ONNX boundary before it writes
`conversion-report.json`. Activation additionally requires the production
browser comparison in `validation/`. The checked-in manifest points to an
immutable dataset commit and records every runtime asset's byte count and
SHA-256.
