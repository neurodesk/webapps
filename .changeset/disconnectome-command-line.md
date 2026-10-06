---
"disconnectome": minor
"@neurodesk/nii2tvx": minor
---

Add the `disconnectome` command line. It scores a NIfTI lesion against the ENIGMA Symmetric or HCP1065 atlas with the app's WebAssembly query core and writes the app's TSV download byte for byte. Atlases come from the pinned manifest with SHA-256 checks on every load and an offline mode. A lesion off the MNI152 1 mm grid is refused with the app's SYNcro advice. Portable Linux x64, Windows x64 and macOS arm64 archives bundle a private Node runtime and both atlases. Each archive must reproduce the native `nii2tvx` table for every example lesion and atlas before release. The app now takes its table name and grid refusal from `@neurodesk/nii2tvx/disconnectome`.
