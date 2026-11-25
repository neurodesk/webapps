# Brainchomp

Browser-only rodent brain extraction for mouse and rat MRI, powered by
[Brainchomp](https://brainchomp.org/) (`neuroneural/brainchomp`, MIT) and
`brainchomp-lib`.

Select a rodent MRI example or load a NIfTI volume or DICOM series with true
voxel dimensions (not ×10-scaled headers for human tools). If a quadruped scan
loaded with mis-labelled biped DICOM axes, use **Reorient…** to update the
header affine before extraction. Select **Extract brain** to produce a
skull-stripped brain image and a post-processed binary brain mask on the input
image grid. **Edit** on the Mask row corrects the mask in the viewer before
downloading.

Processing runs locally in a Web Worker on WebGPU (fp16), falling back to
hardware WebGL2 and then to the threaded CPU WebAssembly module on
cross-origin isolated pages. Software GPU rasterizers are skipped in favour of
the threaded CPU module.

Vendored runtime assets come from `neuroneural/brainchomp` commit
`51a90203f497cea6b3cf01e34bd113f8c2a6292c` (`brainchomp-lib` `0.1.20261015`,
commit `95c8b9bd186f0fcffabb797e1fe770c26659750e`). Example volumes are
mirrored and pinned on Hugging Face (`neurodeskorg/webapps`).

```sh
pnpm --filter brainchomp dev
pnpm --filter brainchomp build
pnpm --filter brainchomp test
pnpm --filter brainchomp test:e2e
```
