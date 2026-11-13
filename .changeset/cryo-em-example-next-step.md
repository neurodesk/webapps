---
"cryo-em": patch
"@neurodesk/webapp-components": minor
---

Loading the RELION tutorial example in Cryo-EM now shows the next step only in the status bar (connect a server with the movies, choose a project or import) instead of only "…loaded.". An example selector's `onLoad` can replace its loaded message through the new `setMessage` context call and hide its inline copy when routing it to the footer.

Refresh the footer when the server disconnects or the selected project changes so tutorial readiness cannot outlive its prerequisites.

Invalidate late project, tutorial and job responses when their context changes. Show submission progress immediately, keep Run disabled while opening a project and prevent example loading from replacing a running job's status.
