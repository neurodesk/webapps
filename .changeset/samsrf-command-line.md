---
"samsrf": minor
"@neurodesk/samsrf": minor
---

Add a portable `samsrf` command line for Linux, Windows and macOS. `samsrf prf|rc|cf MODEL.json OUTPUT_DIR --runs RUN.gii ...` runs SamSrfAnalysis on GIfTI runs with `--roi`, `--apertures`, `--seed`, `--template` and `--surf` (or `--white` and `--area`), SamSrf's normalise and average switches (`--no-normalise`, `--concatenate`) and `--shards N` worker threads, and writes the web app's GIfTI map set with a provenance file. `@neurodesk/samsrf/node` gains `readAnalysisInputs`, `analysisSpec`, `runJob` and `shardRanges`, which the command line and the validation share. Its release check runs `rc` on the example's V1-V3 label and the `prf` fit and `cf` on 200 vertices, and holds every map byte for byte to the same job run in-process. The package now follows the app's date version.
