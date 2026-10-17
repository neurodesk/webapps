---
"@neurodesk/webapp-components": patch
---

The input menu now reads "Load data or example…", and its file actions are **Load files…** and **Load folder…**. In Chrome and Edge on desktop they open the browser's Open and Select dialogs instead of the file input's, which asked to "Upload" files: nothing is uploaded, and the menu no longer says so. A folder's files keep their paths within it, as a dropped folder's do. Other browsers, and any browser where those dialogs fail, open the file input's picker as before.
