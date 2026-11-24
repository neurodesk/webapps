# MedSAM2

Interactive 3D segmentation of MRI and CT scans in the browser using **MedSAM2**
(`sam2.1_hiera_t512`, Ma et al. 2025), fine-tuned from Meta's Segment Anything Model 2.1.

## Pipeline

1. **Input**: 3D NIfTI (`.nii` / `.nii.gz`) or DICOM series (converted locally via `dcm2niix`),
   oriented to canonical RAS for consistent axial/coronal/sagittal slicing while keeping the
   native NIfTI grid and affine for output export.
2. **Intensity windowing**: Auto 0.5–99.5% percentile for MRI or CT Hounsfield presets
   (soft tissue, lung, bone, brain), scaled to `[0, 255]`, bilinearly resized to `512 × 512`,
   replicated to 3 channels and ImageNet-normalized.
3. **Interactive 2D prompting**: Clicking positive/negative points or dragging a bounding box on
   a slice runs `medsam2-image-encoder.onnx` (cached per slice) and `medsam2-mask-decoder.onnx`
   with SAM 2's dynamic stability fallback (`delta = 0.05`, `thresh = 0.98`).
4. **3D memory propagation**: Clicking **Propagate in 3D** encodes the prompted slice with
   `medsam2-memory-encoder.onnx` (`binarize_mask_from_pts_for_mem_enc = true`), then propagates
   bidirectionally (`+slice` and `-slice`) using `medsam2-memory-attention.onnx` (up to 7 spatial
   memories + 16 object pointers with signed temporal positional encodings) and
   `medsam2-mask-decoder.onnx`.
5. **3D viewing & manual refinement**: Switch to **3-Plane** or **3D** to view the segmentation
   overlay in NiiVue, or click **Edit** on the output row to refine masks by hand with
   `nd-mask-editor`.
6. **Outputs**: `<stem>_medsam2_seg.nii` (uint8 label map on the input's native voxel grid and
   header) and `<stem>_medsam2_volumes.tsv` (per-label voxels, volume in mm³ and mL, slice count,
   centroid and bounding box).

## Validation

Exported with `validation/export_onnx.py` (PyTorch 2.5.1, opset 17, `MedSAM2_latest.pt`) with
target-independent ORT basic constant folding on the image encoder. Preprocessing uses bilinear
resize to `512 × 512` and skips optional CUDA connected-component hole filling (`fill_hole_area = 0`),
matching PyTorch CPU `SAM2VideoPredictor`. `validation/reference.json` stores PyTorch reference
masks on `T1_head.nii.gz` (including a 10-slice rolling-memory box case and a single-point case),
verified directly in the browser by `e2e/workflow.spec.js`.
