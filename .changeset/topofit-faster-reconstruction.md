---
"topofit": minor
"@neurodesk/topofit": minor
---

Reconstruct cortical surfaces about twice as fast with byte-identical results: 73 s instead of 153 s on the validation scan. ONNX Runtime uses a fixed two threads, the conformer and intensity quantiles do the same arithmetic with less work, and both hemispheres reconstruct at once. Parallel hemispheres need about 3 GB more memory; an Advanced setting runs one hemisphere at a time, and TopoFit switches to it after a failed or crashed parallel run. Mesh models download once per run. The parity gate now also requires every output to match the pinned production bytes.
