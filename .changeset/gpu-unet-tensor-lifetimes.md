---
"@neurodesk/runtime-support": patch
"@neurodesk/synthseg": patch
"@neurodesk/synthsr": patch
"synthseg": patch
"synthsr": patch
---

Allocate WebGPU U-Net activation buffers per tensor at their exact size and destroy each buffer as soon as its last consumer finishes, rather than keeping all max-sized slots and the output readback buffer resident across passes. Destroy the readback buffer on output disposal and release the input and ONNX model buffers once setup completes in SynthSeg. On the 192×224×160 full-volume SynthSeg graph this cuts GPU activation and readback memory from 4.74 GiB resident across the whole run to 0 GiB between passes, < 0.9 GiB during early steps (avoiding Metal's watchdog stall when faulting back a swapped 1.85 GiB slot on a 7 GB Apple runner), and 3.69 GiB at the single Concat peak, with every shader, dispatch and output byte unchanged.
