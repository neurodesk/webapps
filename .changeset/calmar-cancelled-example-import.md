---
"calmar": patch
---

CALMaR no longer attaches a superseded diffusion scan to the subject loaded after it: a DWI/TRACE, ADC or b0 import that is still being read or decoded is discarded when an example, a newer file in the same input or a new structural image replaces it. This holds for a cancelled acute example and for the user's own files.
