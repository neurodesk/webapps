---
"topofit": minor
"@neurodesk/topofit": minor
"syncro": patch
"@neurodesk/syncro": patch
---

Add the `topofit` command line: CPU reconstruction with ONNX Runtime Node, offline model installation with SHA-256 checks on every load, portable Linux x64 and Windows x64 archives, and a Developer ID signed, notarized macOS arm64 installer package that installs `/usr/local/bin/topofit`. Each bundles Node and the T1-weighted models, and each must match the OpenRecon end-to-end reference before release. SYNcro's portable archives are now built by the shared `exes/node-cli` packager; their contents and behaviour are unchanged apart from the launcher binary.
