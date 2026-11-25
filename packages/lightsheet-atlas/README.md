# `@neurodesk/lightsheet-atlas`

Shared registration, cell detection and region counting core plus portable command line for the Neurodesk Light-sheet atlas web app.

## Usage

```bash
# Verify installation, Greedy WASM runtime and Allen CCFv3 50 µm atlas cache
lightsheet-atlas self-check

# Download and SHA-256 verify the pinned Allen CCFv3 50 µm atlas files
lightsheet-atlas download-models

# Register a cleared mouse brain stack (orientation psl)
lightsheet-atlas brain.ome.tif results --orientation psl

# Detect cell candidates on a full-resolution crop without atlas registration
lightsheet-atlas crop.ome.tif results --no-register --detect
```

## Environment variables

- `NEURODESK_LIGHTSHEET_ATLAS_MODEL_DIR`: override the directory containing the Allen CCFv3 50 µm atlas files (`allen_mouse_50um_template.nii.gz`, `allen_mouse_50um_annotation.nii.gz`, `allen_mouse_50um_structures.json`).
- `NEURODESK_OFFLINE=1`: refuse network downloads and require verified local atlas assets.

## Licence and atlas terms

The application code is Apache-2.0 and the cellfinder detection port (`src/detect.js`) is BSD-3-Clause (see `LICENSE`, `LICENSE-cellfinder`, and `NOTICE`). The Allen Mouse Brain Common Coordinate Framework v3 is distributed for research and noncommercial use only under the Allen Institute terms of use.
