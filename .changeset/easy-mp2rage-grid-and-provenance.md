---
"easy-mp2rage": patch
"@neurodesk/easy-mp2rage": patch
---

The web app and the command line refuse INV1 or INV2 images that have UNI's dimensions but a different orientation, voxel size or origin, instead of combining them voxel for voxel with the wrong anatomy. `parameters.json` now records every setting that changes a result: the tfl reference angle, FOV extension, the uncorrected fallback and whether the mask came from INV2 or UNI. Each release archive is checked against Python pipeline outputs for every option, and the committed WebAssembly core is rebuilt from source and compared before packaging.
