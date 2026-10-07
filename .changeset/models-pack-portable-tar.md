---
"@neurodesk/desktop": patch
---

Write the models pack without GNU tar. The archive is now produced in Node as a plain USTAR stream, so it builds on macOS and Windows as well as Linux and stays byte-identical for the same models. Its checksum differs from packs written by GNU tar, so the next release uploads the pack once more.
