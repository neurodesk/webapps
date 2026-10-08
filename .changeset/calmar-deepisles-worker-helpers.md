---
"calmar": patch
---

Make the DeepISLES DWI/ADC seed route runnable once its asset is validated: its helpers were declared inside the registration step and the affine reader was never imported, so the route would have stopped with a ReferenceError. Zero background voxels now stay zero under the nonzero z-score, as in MONAI's `NormalizeIntensity(nonzero=True)`. The atlas loader's fallback import of the bundled NIfTI parser now points at the file that exists.
