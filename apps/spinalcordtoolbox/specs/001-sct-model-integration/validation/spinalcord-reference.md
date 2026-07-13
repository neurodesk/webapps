# SCT Spinal Cord Reference Validation

Use only public, synthetic, or de-identified data.

Reference command:

```bash
sct_deepseg spinalcord -i INPUT.nii.gz -o reference_spinalcord.nii.gz
```

Browser validation must compare:

- Output dimensions
- Voxel spacing
- Orientation and affine relationship
- Foreground label semantics
- Mask agreement with documented tolerance

Current status: blocked until a browser-runnable SCT `spinalcord` model asset is
converted and validated.
