---
"pipeline-builder": patch
---

Validate with the NeuroFlow v0.7.0 core. It reports a `local-id-invalid` error for an input, context field, step or output name that does not match the spec's local identifier pattern, and tags the error for a workflow output that does not reference a step output with `output-ref-not-step`. Point the run instructions at the v0.7.0 release, where a run fails when a workflow output not marked `optional` is not produced.
