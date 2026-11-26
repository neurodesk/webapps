---
"topofit": patch
---

Upgrade TopoFit to `@niivue/niimath@1.4.20261114` and export printable binary STL surfaces through the fluent `Niimath` worker API instead of calling Emscripten `callMain` directly and round-tripping mz3 through `readMz3`/`writeStl`.
