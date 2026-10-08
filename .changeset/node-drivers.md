---
"@neurodesk/runtime-support": minor
---

Add Node drivers for portable command lines. `@neurodesk/runtime-support/node/niimath` runs a niimath argv over in-memory files in a fresh WebAssembly instance. `@neurodesk/runtime-support/node/mindgrab` runs MindGrab, MindMap, MindSnap and the 18-class model on the CPU under Node, with the browser wrapper's options and result shape. Both reproduce the browser's outputs byte for byte; `validation/reference.json` pins them and `node-drivers.yml` checks them on Linux, Windows and macOS.
