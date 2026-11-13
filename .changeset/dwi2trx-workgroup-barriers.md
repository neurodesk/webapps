---
"dwi2trx": patch
---

Streamline tracking now synchronises lanes with real workgroup barriers. Each GPU workgroup tracks one seed with one 32-lane subgroup, so the barriers the original kernels need are guaranteed on every GPU, including NVIDIA GPUs whose lanes are not in lockstep. Results are unchanged.
