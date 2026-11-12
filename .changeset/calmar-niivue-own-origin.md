---
"calmar": patch
---

Serve NiiVue from CALMaR's own origin. The page loaded NiiVue from unpkg with a classic script tag, so one failed request to that host left the app without its viewer and startup stopped with `niivue is not defined`. The build now fetches the same pinned NiiVue 0.68.2 file, checks its SHA-256 and ships it with the app.
