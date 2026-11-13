---
"calmar": patch
"@neurodesk/webapp-components": minor
---

CALMaR preserves the drawing and Undo history of an open lesion-mask review when a superseded image, seed or viewer stack finishes loading. Superseded loads are decoded away from NiiVue and refused before insertion, so they cannot replace the review's image or drawing. Late failures also leave replacement inputs, layers and results untouched.

`ViewerController.loadBaseVolume`, `loadOverlay` and `loadVolumeStack` accept `assertCurrent` for two-phase loading. The controller checks ownership immediately before synchronously inserting and recording decoded images, ending with `onCommit`. Each decode owns its object URL. Failed or superseded stacks release decoded members without waiting for pending members. `replaceStage` replaces an overlay during the commit. Calls without `assertCurrent` retain their previous behavior.

Start over and Clear results release the viewer queue immediately, even when an older decode never settles. A partial clear reloads the retained input and preserves layer visibility. Repeated layer loads and threshold previews keep one tracked overlay per stage.

An open mask review keeps its native image and grid. Registration QC, subject-atlas and blend controls stay disabled until review ends; prealignment is refused unless confirmation requests it. Deferred threshold previews resume when the review ends. A failed review releases its base lock and can be retried, including failures during seed preparation.

Review preparation and confirmation now run through one ownership gate before every asynchronous continuation, including failure handlers. Replaced reviews cannot enable drawing tools, publish wand restrictions, launch preparation work, save an old drawing or open a review on a replacement subject. The same owner follows nested prealignment, segmentation, viewer preparation and worker commands. Replacing a review cancels its preparation worker and settles pending waits.

Worker waits are released on preparation failure and cancellation, including before dispatch and during initialization. Commands recheck ownership after initialization, and initialization waits cannot borrow readiness from a replacement worker. Replacing unfinished review preparation releases its base and render locks immediately. Cleanup removes only its own waits and preserves a still-current shared worker. QC, layer, patient-atlas and automation preparation continuations keep their original owner through rendering.

Checked viewer commits release uninserted decoded images and unused object URLs even when synchronous NiiVue insertion or configuration throws.

Replacing unfinished review preparation also detaches its viewer queue, so a drawing decode that never settles cannot block a replacement review of the same subject.
