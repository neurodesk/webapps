---
"calmar": patch
"@neurodesk/webapp-components": minor
---

CALMaR keeps the edits drawn in an open mask review when an older viewer load finishes late. A structural image or mask seed that a newer structural image had replaced could still finish loading during the review of the newer image; the review was then started again from its seed, and the voxels drawn since, with their Undo history, were lost. The late image is now removed under the drawing, and a late seed no longer reaches it.

A brain mask overlay that finishes loading after Clear results, or after a new structural image, is removed again. It could become the viewer's base image, below the structural image.

A registration QC view, network map or other viewer stack that finishes loading after Clear results or a new structural image is removed again, and can no longer replace the image under an open mask review. The brain mask shown during a mask review is removed when it finishes loading after Clear results. Switching a viewer layer on, off and on while it loads no longer leaves a second copy of the overlay that stayed visible with the layer switched off.

Start over no longer waits for a viewer load that is still in progress: the structural image returns at once and a new mask review opens on it, also when the earlier load never finishes. A threshold preview that finishes loading after a newer one no longer leaves a second copy that stayed visible with the threshold layer switched off.

A viewer load that a newer image, a clear or Start over replaced no longer reaches the viewer at all, where it used to be removed again after it arrived. A mask review can no longer end up with a drawing on another image's grid, a structural image replaced twice no longer returns, and Start over keeps a lesion mask loaded on its own hidden when its layer was switched off. A review that cannot get its drawing ends and can be started again.

`ViewerController` in `@neurodesk/webapp-components/viewer` gains two-phase loading: `loadBaseVolume`, `loadOverlay` and `loadVolumeStack` given `assertCurrent` decode the file away from the viewer, call `assertCurrent()` and then insert the image and update the controller's record in one synchronous step, ending with `onCommit()`. A load without `assertCurrent` behaves as before.
