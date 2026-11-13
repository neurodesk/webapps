---
"cryo-em": patch
"@neurodesk/webapp-components": minor
---

Loading the RELION tutorial example in Cryo-EM now shows the next step in the status bar (connect a server with the movies, create a project or run Import) instead of only "…loaded.". An example selector's `onLoad` can replace its loaded message through the new `setMessage` context call.
