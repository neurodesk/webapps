---
"@neurodesk/hmc-registration": minor
---

Accumulate ITK's Mattes metric in float64: the joint and marginal PDFs, their sums, the metric value and an affine's derivative. Images, fields and transforms stay float, `--float 1` is still required, and no `antsRegistration3DDouble` is built. On the 1.2 mm SyN-SDC grid the field map now differs from native double by 0.031 Hz end to end (it was 0.538 Hz) and by 0.040 Hz on the SyN-only replay. Both are under the 0.05 Hz floor, so the Q66 gate of #462 holds. SyN still peaks at 2.26 GB of WebAssembly memory. Registrations with the `GC` or `CC` metric (HMC, the synthetic restricted-SyN test pair) and `--apply` (BISON) write the same bytes; a Mattes registration writes the bytes of a native ANTs build with the same change, now the package's goldens.
