---
"dicomview": minor
---

A series conversion keeps running when another series is chosen; only a new input or the footer × ends it, so browsing a folder converts each series once instead of again on every switch.

Convert all, in the Series section, converts every series one after another in the background, with progress in the status bar; the chosen series goes ahead of the queue and a converted series is marked in the list.

Converted images and their anonymised sidecars are saved in the browser's origin private file system, keyed by a fingerprint of the series' content, so the same folder opens without dcm2niix after a reload. Clear saved removes them; a browser without that storage keeps the conversions in memory for the session. Privacy and About describe the saved images.
