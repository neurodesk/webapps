---
"qsmbly": patch
"@neurodesk/webapp-components": patch
---

Merge upstream astewartau/qsmbly 2f91e83..d2afebc:

- One numerical path: total- and local-field maps and QSMART run through the same config-driven qsm-core stages as raw phase, so the same settings give the same numbers whichever input they start from (#142). Field strength is always required; TGV and MEDI on a field map ask for its echo time.
- TGV's regularization level decides its alphas from the first run, and the exported command names the alphas that ran (#142). V-SHARP and iLSQR defaults come from the generated qsm-core defaults (#131).
- Deep-learning tile patches are capped at 120 voxels so they fit browser memory (#137).
- Gzipped NIfTI masks and field maps are decoded with their scaling, and field-map voxel sizes set the defaults (#130). A 4D mask is refused instead of silently truncated.
- The WASM module failing to load is reported instead of hanging, and Cancel during loading settles (#128). Mask paths report errors that used to fail silently (#126).
- File names are escaped in the mask list and the import triage (#132). dicompare loads on first use, so an unreachable dicompare.neurodesk.org only disables the report (#130).
- Accessibility: labelled controls, hidden-attribute settings panels, and dialogs that take focus, trap Tab, close on Escape and return focus (#133, #139; the shared ModalManager now does this for every app). Tagify is pinned to 4.39.0 with subresource integrity.
- The shared decodeNiftiBuffer can stop after the header (`{ maxBytes }`).
