---
"@neurodesk/webapp-components": patch
---

Remove closed class-toggled dialogs from the accessibility tree and keyboard navigation using synchronized inert and aria-hidden state, preserving fade transitions and focus restoration. This prevents repeated attempts to dismiss an already-closed SCT About dialog.
