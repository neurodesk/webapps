---
"medsam2": minor
"microsam": minor
---

Add the MedSAM2 interactive 3D medical segmentation app (`apps/medsam2`) using SAM 2.1 Hiera-Tiny (`MedSAM2_latest.pt`) exported to four opset-17 ONNX graphs with pixel-exact 2D slice prompting, bidirectional 3D memory-bank propagation, NiiVue 3-plane/3D viewing, `nd-mask-editor` refinement, NIfTI label and native-grid volumetric TSV export (honouring NIfTI spatial units and sform affine determinants), DICOM conversion, and WebMCP automation. Extend micro-sam (`apps/microsam`) with the electron-microscopy organelle model (`vit_t_em_organelles`) and 3D OME-TIFF / ImageJ TIFF Z-stack interactive segmentation with bounded per-slice embedding caching, bidirectional 3D box-projection propagation, multi-page ImageJ Z-stack label TIFF export (carrying `images`, `slices`, and spacing metadata when present), and 3D object CSV measurements.
