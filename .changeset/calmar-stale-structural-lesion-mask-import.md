---
"calmar": patch
---

CALMaR no longer applies a superseded structural image, lesion mask or uploaded manual mask: an import that is still being read or converted from DICOM is discarded when a newer file in the same input, an example or a full clear replaces it. An uploaded manual mask is also discarded when a new structural image, a blank mask or Clear results replaces it.
