---
"samsrf": minor
"@neurodesk/samsrf": minor
---

SamSrf results can be downloaded losslessly. Beside the float32 GIfTI maps, the app and the `samsrf` command line write `<prefix>_lossless.bin`: every `Srf.Data` value in float64 (NaN payloads and signed zeros kept), the imaginary parts of a complex SamSrf-convention CSS fit, `Srf.Raw_Data` and the analysed vertices, in a small documented format (`writeLossless`, `readLossless`; README "Lossless export"). Both write the same bytes for the same result, and each provenance JSON names the file and its SHA-256. The app lists it in the results and the zip, and automation returns it as the `lossless` artifact. The validation comparators read it: `compare_ui_cli.py` compares a download's double values and imaginary parts with MATLAB and requires them to equal the engine harness's, and `lossless.py` does the same for one file from the command line. The GIfTI maps, defaults and refusals are unchanged.
