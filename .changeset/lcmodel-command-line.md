---
"lcmodel": minor
"@neurodesk/lcmodel": minor
---

Add the `lcmodel` command line. `lcmodel SPECTRUM [WATER ...] OUTPUT_DIR` runs the web app's fit operation in Node: FID-A preprocessing, the recommended or chosen basis set, and the LCModel fit, with the same WebAssembly module and every automation option. It reads the app's formats (twix, RDA, DICOM, P-file, SDAT/SPAR, NIfTI-MRS, Bruker, LCModel .RAW) and writes the app's downloads under the same names. Several datasets are fitted into the app's group tables. The app and the command line share one workflow module, so they make the same choices. Portable archives for Linux x64 and Windows x64 and a signed macOS installer include all 25 basis sets and run offline. Their release check requires every download on every example to match the web app's byte for byte. Tissue correction takes entered fractions; segmenting a T1 needs the web app until #203.

The app's automation now applies `frequencyMHz` and `dwellTimeMs` to an LCModel .RAW; before, the file's own values replaced them as it loaded. A .RAW whose `$SEQPAR` names MEGA-PRESS is now fitted as a difference spectrum (mega-press-3 with the co-edited macromolecule model), as its recommended basis set already assumed; `edited: false` fits it as an unedited spectrum. The app version in reports now comes from the app's package.json.
