---
"@neurodesk/desktop": patch
---

Wait for partial output cleanup before publishing a failed or cancelled automation run, so clients cannot observe a completed run while its outputs are still being removed.
