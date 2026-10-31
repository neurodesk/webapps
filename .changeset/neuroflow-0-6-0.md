---
"pipeline-builder": patch
---

Validate with the NeuroFlow v0.6.0 core. It reports an `unknown-field` error for any key a workflow declaration does not allow, an `input-undeclared` error for a reference to an undeclared workflow input, and a `constant-invalid` error for a constant that does not match its input. The builder's own undeclared-input check is removed. Its constant check now reports only what the core does not (per-item array limits), so each problem is reported once. Point the run instructions at the v0.6.0 release, where a run fails when a workflow output not marked `optional` is not produced.
