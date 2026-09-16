# Cell microscopy stack example

The example is BioIO's `s1_t7_c4_z3_Image_0.zarr`, pinned to Git commit
`474c7afea51ca94fc21f575f64aad3629224e61e` in
[bioio-devs/bioio-ome-zarr](https://github.com/bioio-devs/bioio-ome-zarr).
The original Git LFS bytes are mirrored in `neurodeskorg/webapps` at Hugging
Face commit `560955bf9a1a669bbf2a89709b64f3e64eefe008`, under
`examples/zarro/microscopy-stack/`. The app streams this pinned mirror.
`examples.json` lists both group metadata files and the array metadata
and first-time/first-channel chunk at each of four resolution levels. These ten
files cover every resolution and slice accessible through ZARRo's current
first-time/first-channel loader; the remaining time points and channels are
not exposed by the app.

The highest resolution is 1800 × 1200 × 3 voxels, stored as uint16 OME-Zarr v2.
The full source has seven time points and four channels. A read through
Zarrita found first-plane intensities from 6687 to 20368, and browser review
confirmed visible cell bodies and processes. The stack has only three planes;
it demonstrates microscopy streaming and resolution changes rather than a
deep volumetric acquisition.

Selection opens the store through the ordinary custom-URL streaming path.
After loading, users can inspect the planes, change resolution, adjust contrast
and download a NIfTI field of view.
