---
"cryo-em": patch
"@neurodesk/webapp-components": minor
---

Loading the RELION tutorial example in Cryo-EM now shows the next step only in the status bar (connect a server with the movies, choose a project or import) instead of only "…loaded.". An example selector's `onLoad` can replace its loaded message through the new `setMessage` context call and hide its inline copy when routing it to the footer.
