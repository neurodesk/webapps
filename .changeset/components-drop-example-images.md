---
"@neurodesk/webapp-components": minor
---

Remove the `@neurodesk/webapp-components/example-images` subpath export (`NIFTI_EXAMPLES`, `NIIMATH_EXAMPLE_BASE_URL`). Importing it now fails. No app has used it since examples moved to `examples.json`, and it pointed at unpinned NiiVue demo images; declare examples in an app's `examples.json` instead.
