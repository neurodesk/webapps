---
"white-matter-lesions": patch
"@neurodesk/webapp-components": patch
---

White matter lesions reads only the NIfTI header when an image is chosen. It used to copy the whole image into memory to read its dimensions, which added a second copy of a 1 GB FLAIR to the load. The shared `readNiftiHeader(file)` reads the first bytes of a plain or gzipped file, and `describeNiftiFile` is built on it.
