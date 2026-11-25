# pipeline-builder instructions

- Validation is NeuroFlow's core, vendored as WASM (`vendor/neuroflow/README.md`, `provenance.json`). Import/export keeps the workflow's `neuroflow` version; 0.1.0 or missing becomes 0.1.1.
- NeuroFlow core v0.6.0 reports undeclared `inputs.<name>` refs (`input-undeclared`) and invalid constants (`constant-invalid`: type, integer, enum, min/max). v0.7.0 adds `local-id-invalid` for input, context field, step and output names outside the spec's `localId` grammar, and `output-ref-not-step`; the builder has no copy of either. The builder's `constant-invalid` check in `workflowIssues` stays for the per-item limits in `neurodesk/parameter`; `validator.js` drops it where the core already reported that path. PR #648 also adds typed array parameters and import shape checks in `parseWorkflow`.
- Optional-output warnings come only from the core (v0.3.2 matches the removed builder check on every catalog binding).
- Open: `bindNewWorkflowInput` drops item bounds; carrying `minItems`/`maxItems` needs the generator to emit them and a 0.1.2 document. If it does, the core's item-count issue will duplicate the builder's `input-count` warning.
