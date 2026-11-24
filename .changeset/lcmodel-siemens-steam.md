---
"lcmodel": patch
"@neurodesk/lcmodel": patch
---

Improve Siemens STEAM support and add a de-identified Siemens 7 T STEAM example (`steam7t.dat` + `steam7t_w.dat`, CC-BY-4.0, Zenodo 5654857): write each dataset's sequence family into the exported `.RAW`/`.H2O` `$SEQPAR` block (eliminating spurious `ERROR MYBASI 11` diagnostics on STEAM fits and explaining genuine `MYBASI 11` mismatches), read and match STEAM mixing time (`TM`) across TWIX/DICOM/RDA/NIfTI-MRS and basis selection, auto-pair raw Siemens TWIX `meas_MID..._FID...` metabolite and water-reference filenames, and guard bad-average removal on scans with fewer than three averages instead of trapping in WASM.
