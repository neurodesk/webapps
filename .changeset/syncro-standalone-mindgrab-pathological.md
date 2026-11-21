---
"syncro": patch
"@neurodesk/syncro": patch
---

The standalone `syncro` command now matches the web app: it extracts the brain with MindGrab by default (CPU WebAssembly through `@neurodesk/node-drivers`, the web app's pinned 0.1.20260813; `--brain-extractor synthstrip` keeps the previous default) and accepts a pathological-modality scan (`--pathological FILE`), registered to the primary scan with Greedy's affine before normalization, with a `--lesion` map on its grid. On the release check's scan, MindGrab raised Greedy's brain Dice from 0.967 to 0.977.
