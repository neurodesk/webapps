---
"@neurodesk/runtime-support": patch
"@neurodesk/synthseg": patch
"@neurodesk/synthsr": patch
"synthseg": patch
"synthsr": patch
---

Cut the WebGPU U-Net's memory footprint to reduce the risk of a full-volume SynthSeg run stalling into Metal's command-buffer watchdog on a 7 GB Apple runner: the planner grows a free activation slot instead of adding one (the 192×224×160 plan drops from 5.16 GiB to 3.89 GiB of buffers, every shader and byte unchanged), and the output is handed out over the mapped readback instead of a 0.9 GB copy.

Keep the native Metal activation planners in sync, and bind mapped-output disposal to its own run so a stale result cannot invalidate newer output. Released outputs reject reads; error scopes and session release unmap retained data.
