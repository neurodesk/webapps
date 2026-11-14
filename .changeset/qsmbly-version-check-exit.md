---
"@neurodesk/qsmbly": patch
---

When the bundled QSMxT cannot start, `qsmbly self-check` now reports its exit code (in hex on Windows, such as 0xC0000135 for a missing DLL) or signal instead of an empty message.
