---
"dwi2trx": patch
---

Track streamlines in short GPU commands that pause and resume. Each seed now advances at most 32 tracking steps per command and saves where it stopped, so no workgroup runs long enough for a driver to reset the GPU: on Intel Arc with Mesa, one workgroup tracking all of a seed's streamlines ran past the 640 ms preemption timeout and lost the device (#598). The steps and random draws are unchanged, so the tractogram is byte for byte the same.
