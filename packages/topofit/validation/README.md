# TopoFit parity validation

The release gate compares the production browser app with OpenRecon TopoFit 0.5.1 in two cases based on OpenNeuro `ds000001/sub-01/anat/sub-01_T1w.nii.gz`.

- The controlled case gives both implementations the identical browser-resampled 1 mm RAS volume and runs OpenRecon with `--no-conform`. It isolates ONNX conversion, browser execution, geometry, and serialization.
- The end-to-end case gives both implementations the original anisotropic volume. It also measures the expected difference between the browser's Niimath Lanczos conformer and OpenRecon's nibabel cubic conformer.

The reference is the real CPU neural path from the immutable container `vnmd/topofit_0.5.1@sha256:dff22ad5577a1a7ba0530759e009f293271ea5ddfc3441fb35b61322bbd6ec29`. It is not the container's mock mode. The browser run loads the same scan through the public UI, executes the production worker and ONNX Runtime WebAssembly, and downloads the same six FreeSurfer files and QC NIfTI exposed to a user.

Run from the repository root with an empty work directory. The controlled input is pinned to the immutable published release; its SHA-256 is `69dc5c8be1850422e30ce8b03c6b434bb919c0427a3ec79e79b7552b4c00db5e`.

```bash
topofit_work=/storage/tmp/topofit-validation
mkdir -p "$topofit_work"
curl -fL https://s3.amazonaws.com/openneuro.org/ds000001/sub-01/anat/sub-01_T1w.nii.gz -o "$topofit_work/sub-01_T1w.nii.gz"
curl -fL https://huggingface.co/datasets/neurodeskorg/webapps/resolve/b438d1162e7192ca425ca47282b06fe62340c85a/topofit/0.5.1/onnx-20260911/validation/inputs/sub-01_T1w.browser-1mm.nii.gz -o "$topofit_work/sub-01_T1w.browser-1mm.nii.gz"
packages/topofit/validation/capture-openrecon.sh "$topofit_work/sub-01_T1w.nii.gz" "$topofit_work/reference"
packages/topofit/validation/capture-openrecon.sh "$topofit_work/sub-01_T1w.browser-1mm.nii.gz" "$topofit_work/reference-controlled" --no-conform

TOPOFIT_ASSET_DIR=/path/to/exported-assets VITE_TOPOFIT_ASSET_BASE=/model-assets/ pnpm --filter topofit build
TOPOFIT_ASSET_DIR=/path/to/exported-assets pnpm --filter topofit preview --host 127.0.0.1 --port 4173 --strictPort
node packages/topofit/validation/browser-run.mjs http://127.0.0.1:4173/topofit/ "$topofit_work/sub-01_T1w.nii.gz" "$topofit_work/browser"
node packages/topofit/validation/browser-run.mjs http://127.0.0.1:4173/topofit/ "$topofit_work/sub-01_T1w.browser-1mm.nii.gz" "$topofit_work/browser-controlled"
python packages/topofit/validation/compare.py "$topofit_work/reference" "$topofit_work/browser" --input "$topofit_work/sub-01_T1w.nii.gz" --conversion-report /path/to/exported-assets/conversion-report.json --mode end-to-end --output "$topofit_work/end-to-end.json"
python packages/topofit/validation/compare.py "$topofit_work/reference-controlled" "$topofit_work/browser-controlled" --input "$topofit_work/sub-01_T1w.browser-1mm.nii.gz" --conversion-report /path/to/exported-assets/conversion-report.json --mode controlled --output "$topofit_work/controlled.json"
```

The comparison requires identical topology and finite output, then measures corresponding anatomical-vertex distance, registration-sphere angle and radius, exact sparse-label Dice, and symmetric QC-label coverage within one source voxel. Exact Dice is reported but is not the QC gate because subvoxel surface differences move points across rounding boundaries. The controlled release gate requires at least 99% one-voxel coverage. Thresholds are engineering regression limits, not clinical validation. One healthy T1 scan does not establish performance across scanners, pathologies, contrasts, or browsers.

The checked-in controlled report passes: mean corresponding surface distance is 0.052–0.062 mm, p95 distance is 0.118–0.142 mm, mean registration error is 0.028–0.041 degrees, and one-voxel QC coverage is at least 0.9996. The end-to-end report deliberately records a measured preprocessing difference: mean surface distance is 0.467–0.562 mm when each implementation uses its own conformer.
