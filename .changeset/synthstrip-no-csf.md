---
"brain-extraction": minor
"@neurodesk/brain-extraction": minor
"@neurodesk/synthstrip": minor
---

Add SynthStrip's no-CSF mode (`mri_synthstrip --no-csf`): an Exclude CSF setting in the brain extraction app and `--no-csf` on the `brain-extraction` command line. It runs FreeSurfer's `synthstrip.nocsf.1.pt` weights, converted to ONNX the same way as the default model, and names its outputs `_synthstrip-nocsf_brain.nii` and `_synthstrip-nocsf_mask.nii`.
