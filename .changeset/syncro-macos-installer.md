---
"syncro": minor
"@neurodesk/syncro": minor
---

Add a macOS arm64 installer package for the `syncro` command line. It installs SYNcro in `/usr/local/lib/neurodesk/syncro` and the `syncro` command in `/usr/local/bin`, bundles Node and the models, and is signed with a Developer ID and notarized for release. The app no longer ships its own download dialog, which the shared bar's Standalone action had replaced, or the npm tarball that only that dialog linked.
