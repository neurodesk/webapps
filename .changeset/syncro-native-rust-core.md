---
"syncro": major
"@neurodesk/syncro": major
"@neurodesk/fastprep": patch
"@neurodesk/registration": patch
"@neurodesk/synthsr": patch
---

SYNcro's pipeline is one Rust core (`exes/syncro`) for the web app and the standalone command. The standalone `syncro` runs native SynthSR, MindGrab (the public BrainChop Core 1.0.0 release binaries, the version the web app uses), greedy-rs and niimath (ANTs SyN from an installed ANTs with `--normalization ants`), with no Node runtime and no model download; `--threads` caps every tool and `--device` chooses where SynthSR and MindGrab run. On a 1 mm T1 with a TRACE scan and lesion it takes 17 s (ANTs 22 s), against 91 s (108 s) for the Node command. The web app runs the same core as WebAssembly and gives the same commands; its outputs agree with the native command's within the release-check tolerances. SynthStrip is no longer part of SYNcro: MindGrab is its brain extractor, with a new MindGrab device setting (automatic or CPU). `--brain-extractor`, `--cache-dir`, `--offline` and `download-models` are removed. fastprep's browser drivers move to the shared `@neurodesk/pipeline-drivers`; the registration kernel exposes its raw argv entry for them.

The standalone release builds Greedy from the same checkout as the browser and retains the notarized macOS
installer and Windows signing support. The browser keeps the verified MNI template separate from uploads
and accepts qform-only NIfTI-2 scans, including 180-degree rotations.
