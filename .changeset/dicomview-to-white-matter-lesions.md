---
"dicomview": minor
"white-matter-lesions": minor
"@neurodesk/webapp-components": minor
"@neurodesk/runtime-support": patch
---

DICOM View can open the selected image in White matter lesions. Open in White matter lesions, under the series, sends the converted 3D image, named as its download is, and the same tab opens White matter lesions with the image loaded and ready to segment. A time series or a single slice keeps the button disabled and says why. Choosing another series while a send is in progress cancels it. DICOM View's automation contract now gives its image artifact the `application/x-nifti` media type.

White matter lesions loads an image sent from DICOM View on opening and reports "Loaded <name> from DICOM View" in the status bar. It never starts segmentation itself.

`@neurodesk/webapp-components/handoff` passes files between apps on one site: `sendHandoff` stores them in IndexedDB and opens the target app; `takeHandoff` claims them once and returns copies. An entry can be opened for 2 minutes, only by the tab that sent it, and is deleted when it is opened. The app shell deletes expired entries whenever an app opens.

The cross-origin isolation service worker bootstrap publishes `coiWillReload`, which resolves once a page knows whether it is about to reload, and `coiHoldReloads`, which stops later automatic reloads. Pages that use neither behave as before.
