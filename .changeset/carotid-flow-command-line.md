---
"carotid-flow": minor
"@neurodesk/carotid-flow": minor
---

Add the `carotid-flow` command line. It detects both carotids in a NIfTI phase-contrast series, as one combined series or an amplitude and a phase file, and writes the web app's label map, temporal SD and curves CSV byte for byte. Settings are checked against the app's automation schema, raw ±4096 phase without `--venc` is refused, and portable Linux x64, Windows x64 and macOS arm64 archives bundle a private Node runtime. Each archive must match the PCMCalculator example pins before release. The detection code moves from the app into `@neurodesk/carotid-flow`, which the app now imports.
