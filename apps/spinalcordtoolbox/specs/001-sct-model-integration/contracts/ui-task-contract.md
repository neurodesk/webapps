# UI Task Contract: SCT Model Integration

## Task Selector

The interface MUST present SCT tasks from `web/models/manifest.json`.

For each task, display:
- Display name
- Category
- Intended anatomy
- Supported contrast or modality
- Support status
- Asset status
- Validation status

The selector MUST NOT display obsolete obsolete model terminology.

## Supported Task State

When a task is `supported`:
- The task can be selected.
- Required assets are loaded or downloaded through the model cache.
- The Run action is enabled after a valid input image is loaded.
- The output label legend uses the task label definition.

## Unvalidated Task State

When a task is `unvalidated`:
- The task can be visible but MUST be clearly marked as not validated.
- The Run action is disabled unless a developer/debug mode explicitly enables it.
- The UI links to documentation explaining what validation is missing.

## Unsupported or Retired Task State

When a task is `unsupported` or `retired`:
- The task can be visible for transparency.
- The Run action is disabled.
- The UI displays the reason and any SCT-recommended replacement.

## Asset Failure State

When assets are missing, stale, too large, or fail to download:
- The UI shows a recoverable error.
- The user can retry where applicable.
- Existing loaded image state is preserved.
- No patient-derived content is written to logs, cache, telemetry, or remote
  services.

## Output State

After successful inference:
- The viewer displays the output as an overlay.
- The label legend matches the selected task.
- Downloaded filenames include the task id and avoid patient-derived path data.
- Output provenance includes app version, task id, model asset id, and source
  version only.
