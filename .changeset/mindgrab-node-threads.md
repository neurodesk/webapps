---
"@neurodesk/node-drivers": patch
"syncro": patch
"@neurodesk/syncro": patch
---

The Node MindGrab driver takes a `threads` option that caps its thread pool, and the `syncro` command passes `--threads` (default `SLURM_CPUS_PER_TASK`) to it, so MindGrab stays within a Slurm allocation instead of starting a thread per core. Outputs are byte-identical across thread counts.
