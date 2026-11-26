---
"@neurodesk/webapp-components": patch
---

Imaging workspace pages are laid out from their first paint. The hosted page now carries the classes of its controls, viewer and status regions, and the shared stylesheets place them on the body until `mountImagingWorkspace` wraps them, so the sidebar no longer shows across the full width while the app bundle loads. The row of the app bar keeps its height before the bar arrives.
