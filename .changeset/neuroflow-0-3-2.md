---
"pipeline-builder": patch
---

Validate with the NeuroFlow v0.3.2 core, which reads spec 0.1.3 workflow documents, accepts an absent value for a workflow output marked optional, and does not warn when an optional output feeds an input with a default. The builder no longer keeps its own copy of the optional-output warning: the core reports it once, with the same paths. Point the run instructions at the v0.3.2 release.
