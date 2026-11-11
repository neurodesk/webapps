---
"@neurodesk/desktop": patch
---

Download each desktop suite's locked offline assets when assembling it instead of requiring a shared GitHub Actions cache. Verify downloaded and cached files against their hashes, and include the shared Python runtime when assembling a single Python app.
