---
"topofit": minor
"@neurodesk/topofit": minor
"syncro": patch
"@neurodesk/syncro": patch
---

Add the `topofit` command line: CPU reconstruction with ONNX Runtime Node, offline model installation with SHA-256 checks on every load, and portable Linux x64, Windows x64 and macOS arm64 archives that bundle Node and the T1-weighted models. Each archive must match the OpenRecon end-to-end reference before release. SYNcro's portable archives are now built by the shared `exes/node-cli` packager; their contents and behaviour are unchanged apart from the launcher binary.
