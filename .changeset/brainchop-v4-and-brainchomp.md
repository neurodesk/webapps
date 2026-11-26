---
"brainchop": minor
"brainchomp": minor
---

Upgrade Brainchop from legacy TensorFlow.js/WebGL to `@brainchop/core@1.0.0` (WebGPU V4, WebGL2, and threaded CPU fallbacks) with MindMap-24, MindMap-16, MindSnap-104, CAT-lite GM/WM/CSF tissue fraction maps, native-space output, and shared mask editing, reusing the deduplicated `_runtime/mindgrab/1.0.0/` binaries.

Add Brainchomp as a new rodent brain extraction app in the `preclinical` catalogue (`preclinicalapps.sciget.org`), powered by vendored `brainchomp-lib` (`0.1.20261015`, WebGPU/WebGL2/CPU WASM), quadruped header reorientation, shared mask editing, and pinned rodent MRI examples.
