---
"@neurodesk/runtime-support": patch
"@neurodesk/synthseg": patch
"@neurodesk/synthsr": patch
"synthseg": patch
"synthsr": patch
---

Cut the WebGPU U-Net's memory footprint so a full-volume SynthSeg run no longer stalls into Metal's command-buffer watchdog on a 7 GB Apple runner: the planner grows a free activation slot instead of adding one (the 192×224×160 plan drops from 5.3 GB to 4.0 GB of buffers, every shader and byte unchanged), and the output is handed out over the mapped readback instead of a 0.9 GB copy.
