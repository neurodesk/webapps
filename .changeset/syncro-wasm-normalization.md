---
"syncro": minor
"@neurodesk/syncro": minor
"synthsr": minor
"@neurodesk/synthsr": minor
"@neurodesk/synthstrip": patch
"@neurodesk/runtime-support": patch
---

Stream SynthSR and SynthStrip CPU inference by operator to avoid oversized browser allocations while preserving the pinned models. Reject normalization with less than one percent positive brain support in the MNI template before exposing downloads. Add numerical parity, allocation, failure recovery, and cropped-head regressions.
