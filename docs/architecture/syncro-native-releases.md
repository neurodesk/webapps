# SYNcro native releases

SYNcro runs one Rust pipeline on both hosts. The browser builds the core as
WebAssembly. The standalone command builds the CLI and runs each stage as a
native process. [SYNcro command reference](../../packages/syncro/README.md)

## Package contents

| Target | Format | Entry point |
| --- | --- | --- |
| Linux x64 | `.tar.gz` | `syncro` in the extracted directory |
| Windows x64 | `.zip` | `syncro.exe` in the extracted directory |
| macOS Apple silicon | `.pkg` | `/usr/local/bin/syncro` |

On macOS, the installer places the package under
`/usr/local/lib/neurodesk/syncro` and links the command into `/usr/local/bin`.
Every package includes the MNI template, tool binaries, model weights, and tool
licenses. Greedy builds from the release checkout so it includes the same fixes
as the browser build. The packager verifies the SHA-256 of each downloaded tool
release. Optional ANTs SyN uses an installation on `PATH` or in `ANTSPATH`.
[Tool manifest](../../packages/syncro/tools.json)

## Package validation

Run the packager on the target operating system with Python 3.13, Node.js, and
Rust installed.

```sh
python3 scripts/package-syncro.py package linux-x64
```

The packager extracts the resulting file and runs the CLI on a pinned scan.
The check compares output geometry, brain overlap, and image correlations
against the MNI template. It verifies that the lesion follows the pathological
image and checks resume after an interrupted run. Results, the archive SHA-256,
and any signing evidence go into the validation receipt beside the package.
[Release check](../../packages/syncro/validation/package-check.mjs)

## Publishing

The `syncro-native.yml` workflow tests the Rust workspaces and compares the
WebAssembly commands against the Rust test fixtures. The release dispatch uses
`sign_release` and checks that the selected commit matches the release tag.
It signs and notarizes the macOS installer and applies the repository's
Windows signing configuration. After verifying the receipts, the workflow
uploads the packages to the existing release and dispatches the Standalone
catalog import.

The web app and Rust workspace share the version in
`apps/syncro/package.json`. The release tooling synchronizes the Cargo version.
Pre-migration tags keep their original Node CLI release source and installation
commands. [SYNcro native workflow](../../.github/workflows/syncro-native.yml)
