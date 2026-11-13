---
"dwi2trx": patch
---

Streamline tracking now recovers from a lost GPU device: it requests a new device and reruns the interrupted seed batch, up to twice per run, and the output is the same as an uninterrupted run's. On GPUs that let WebGPU choose the subgroup size, such as Intel's 16- to 32-lane GPUs, the tracking kernels are compiled for exactly 32 lanes. The report records the GPU, whether its subgroup size was pinned, and how many devices were replaced.
