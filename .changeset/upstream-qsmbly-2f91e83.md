---
"qsmbly": patch
"@neurodesk/webapp-components": patch
"@neurodesk/runtime-support": patch
---

Merge upstream astewartau/qsmbly 6e01b15..2f91e83:

- Load the uploaded mask instead of just listing it (#110)
- Fix multi-echo DICOM imports, image classification, and gzip file filters (#111)
- Fix the settings modal saving values no control ever supplied (#112)
- Add explicit mask alignment repair and anatomical overlays (#114)
- Classify BIDS part-mag/part-phase images (#113)
- Automatically preview mismatched masks on the reference image (#115)
- Bump qsmxt-config to v9.22.0 (#109)
- Add mouse brain masking (RS2-Net, with voxel-scaled BET fallback) (#116)

RS2-Net weights (63 MB, GPL-3.0) come through the shared downloader from the pinned
qsmxt/qsm-onnx-weights revision and are listed in the offline inventory. The shared file-io
module gains `classifyImageComponent` and `sameNiftiGrid`. The shared dcm2niix runtime moves to
@niivue/dcm2niix 1.3.20260724, which converts enhanced multi-echo DICOM into one image per echo.
