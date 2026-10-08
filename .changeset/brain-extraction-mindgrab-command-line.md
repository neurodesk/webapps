---
"brain-extraction": minor
"@neurodesk/brain-extraction": minor
---

Add `--method mindgrab` to the `brain-extraction` command line. It runs `@brainchop/mindgrab`'s CPU module through the shared Node driver with the web app's options and writes the brain image and mask the web app downloads. The web app and the command line now both use `@brainchop/mindgrab` 0.1.20260925. Each release must reproduce the web app's MindGrab CPU result on the pinned T1 example bit for bit, as recorded in a browser, with identical NIfTI headers and brain intensities.
