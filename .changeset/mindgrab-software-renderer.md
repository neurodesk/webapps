---
"@neurodesk/runtime-support": patch
"brain-extraction": patch
"fastprep": patch
"ants": patch
"greedy": patch
"fireants": patch
"browserqc": patch
"syncro": patch
"brain2print": patch
"deface": patch
"noddi": patch
---

MindGrab's automatic backend no longer runs WebGL2 on a software renderer (SwiftShader, llvmpipe), which returned a blank brain mask without WebGPU; the threaded CPU module runs instead. The choice and MindGrab's own output appear in the technical log.
