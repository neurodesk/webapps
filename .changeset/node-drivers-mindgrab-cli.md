---
'@neurodesk/node-drivers': minor
---

Add the `brainchop-mindgrab` command line, which runs the native brainchopC argv (`-o`, `--mask [PATH]`, `--border MM`, `--ct`, `--comply`) on MindGrab's CPU WebAssembly, so Linux containers can skull-strip for meica-rs `--moco` and fastprep without the native build.
