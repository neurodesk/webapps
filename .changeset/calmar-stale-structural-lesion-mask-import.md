---
"calmar": patch
---

CALMaR no longer applies a superseded structural image, lesion mask or uploaded manual mask: an import that is still being read or converted from DICOM is discarded when a newer file in the same input, an example or a full clear replaces it. An uploaded manual mask is also discarded when a new structural image, a blank mask or Clear results replaces it. A late viewer load is discarded as well: an older lesion overlay no longer lands above a newer one, a structural image or mask drawing that finishes loading after Clear is removed again, and a diffusion stand-in no longer cancels a structural image that is still being read. A failed DICOM conversion is logged once.

Replacing the structural image or clearing the results now stops the analysis that was running on the previous image: the worker job is cancelled, a brain mask, lesion seed or registration that arrives afterwards is dropped, and the status bar returns to "Cancelled". A structural example that is cancelled while the viewer loads it is not kept, and neither is a structural image replaced by a file that could not be read. A viewer load that never finishes no longer blocks later loads after a clear or a new structural image. A replaced review or run is no longer logged as a failure.
