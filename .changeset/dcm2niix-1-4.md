---
"@neurodesk/runtime-support": patch
"@neurodesk/webapp-components": patch
"@neurodesk/node-drivers": patch
"@neurodesk/lcmodel": patch
"@neurodesk/mri2vid": patch
"dicompare": patch
"dwi2trx": patch
"synthseg": patch
"dcm2niix": patch
"easy-mp2rage": patch
---

Convert DICOM with @niivue/dcm2niix 1.4.20261029 in every app and command line. The shared client is a thin layer over its `convert`, which pairs sidecars and gradients, times out and terminates its worker; bundler-less apps stage the same JPEG build (JPEG-LS and JPEG 2000) from npm instead of a committed 1.3 copy, and all apps share one WASM. A conversion that yields some images now keeps them; dcm2niix's last log line is reported when none are produced. Output names drop the `input_` prefix and never include the input folder, whose name can identify a patient.
