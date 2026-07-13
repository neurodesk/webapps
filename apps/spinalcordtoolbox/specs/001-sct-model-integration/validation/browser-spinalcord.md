# Browser SCT Spinal Cord Workflow Validation

Current result: not runnable.

Reason: `web/models/manifest.json` marks `spinalcord` as `unvalidated` because a
browser-runnable SCT stable model asset has not been generated and validated.
The UI must show the task and prevent execution rather than running an obsolete
or mismatched model.

Validated so far:

- Manifest schema validation passes.
- JavaScript syntax validation passes.
- Task selector exposes the SCT task state.
- Local dev server serves the SCT entrypoint, task module, and manifest.
- Obsolete model assets were removed from active browser model files.
