---
"edgereg": minor
"@neurodesk/edgereg": minor
---

Add the `edgereg` command line: `edgereg MOVING FIXED OUTPUT_DIR [--robust-fov]` runs the web app's `register` operation in Node with the same niimath `-allineate` WebAssembly build, and writes the web app's download under the same name. The method now lives in `@neurodesk/edgereg`, which the web app imports. Portable archives for Linux x64 and Windows x64 and a signed macOS installer run offline. Their release check registers the pinned example and requires the output's header and voxels to hash identically to the web app's own download; native niimath built from source is held to measured limits.
