# Cortical surface example

`examples.json` pins the left pial surface from the TopoFit end-to-end browser
validation run in `neurodeskorg/webapps`, at Hugging Face commit
`1c3a4b2c508b01171540e3870272d39f66b04004`. This asset was already hosted in
the project dataset and retains its original pinned URL. The reconstructed
cortical surface has 245,762 vertices and 491,520 faces. Its pinned bytes are
recorded in the offline asset inventory.

The selector uses the same mesh loader, adjacency construction, vertex index
and ROI tools as a local surface. Select the example, mark a border, close and
fill it, then export a FreeSurfer label or GIfTI label. Loading the example does
not create an ROI automatically. Existing surfaces and annotations remain
available when another surface is loaded.

Provenance: the pinned dataset directory contains `browser-run.json`,
`topofit_manifest.json`, and the matching white and right-hemisphere surfaces.
