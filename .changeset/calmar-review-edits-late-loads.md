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

While a mask review is open, its image stays in the viewer: Check atlas alignment, Show subject atlas, the registration QC view and the Patient/MNI blend are disabled until the mask is confirmed or the analysis is started over, so a review can no longer be left with a drawing over another image. A viewer layer switched on for a previous image no longer switches off the same layer of the image that replaced it, and a replaced image whose loading fails no longer stops the newer image from loading.

`ViewerController` loads given `assertCurrent` create one object URL per decode and release only that URL when the decode fails or its image is not inserted; an inserted image keeps its URL until it leaves the viewer. `assertCurrent` is also asked when a decode fails, and whatever it throws reaches the caller.

A failure in work for an image that has since been replaced no longer changes the newer image's results: a threshold projection that failed late cleared the newer image's threshold map. A threshold changed during a mask review is drawn when the review ends, however it ends. Pre-align is refused during a mask review, like the registration QC views, so it can no longer leave a drawing over the pre-aligned image.

A `ViewerController` load given `assertCurrent` now ends as soon as its outcome is known: on the first stack member that fails, or when `assertCurrent` throws, which is asked whenever a member is decoded and whenever the viewer changes. Members decoded so far are released then, and a member that is decoded later releases itself. `assertCurrent` is called several times and must have no side effects; `replaceStage` makes an overlay take its stage's place in the commit.

Failed decodes also recheck ownership when the controller resumes, before reporting an error, so a load superseded between decode completion and its continuation stays silent and rejects as superseded.

A review cleared just after its drawing commits also rechecks ownership before enabling its tools or reporting readiness, so the old continuation cannot recreate a drawing in the cleared viewer.

Confirming a mask also owns its review through prealignment, decoding and overlay loading. If another review replaces it while it waits, the older confirmation cannot accept its saved drawing or close the replacement's drawing and Undo history. Cleared review-start and input continuations stop before loading a wand restriction, selecting a pipeline or reporting readiness. Failure handlers for manual review and confirmation also ignore ordinary errors from a replaced review.
