---
"calmar": patch
---

CALMaR keeps the edits drawn in an open mask review when an older viewer load finishes late. A structural image or mask seed that a newer structural image had replaced could still finish loading during the review of the newer image; the review was then started again from its seed, and the voxels drawn since, with their Undo history, were lost. The late image is now removed under the drawing, and a late seed no longer reaches it.

A brain mask overlay that finishes loading after Clear results, or after a new structural image, is removed again. It could become the viewer's base image, below the structural image.
