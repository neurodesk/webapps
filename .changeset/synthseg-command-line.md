---
"synthseg": minor
"@neurodesk/synthseg": minor
---

Add a portable `synthseg` command line for Linux x64 and Windows x64. It runs the web app's pipeline with ONNX Runtime on the CPU, takes the app's `segment` options (`--mode default|fast`, `--ct`/`--no-ct`), and writes the app's two downloads: the label map and its run report. The model is bundled and SHA-256 checked on every load, so a release runs offline. A 1 mm head peaks at about 6 GB of memory. The release check holds every output to the FreeSurfer 8.1.0 goldens with the native parity gates. macOS keeps the native Metal installer, and the Standalone dialog lists all three platforms.
