# Portable Node command-line archives

This directory packages a Node command-line package from `packages/` as a
self-contained archive: a private Node runtime, the package with its production
dependencies, its checksum-pinned models and a small launcher. SYNcro and
TopoFit use it. The launcher contains no scientific code.

The launcher takes the tool name from its own file name. `syncro` or
`syncro.exe` runs `runtime/node app/bin/syncro.js`; `topofit` runs
`app/bin/topofit.js`. It sets `NEURODESK_<TOOL>_MODEL_DIR` to the archive's
`models/` directory and `NEURODESK_OFFLINE=1`, so the first analysis on an
airgapped machine needs no downloads or cache preparation.

Each package describes its archives in `release.json`:

| Field | Meaning |
| --- | --- |
| `displayName` | Name used in `README.txt` |
| `app` | App whose version must equal the package version |
| `run` | Arguments shown after the executable in `README.txt` |
| `readme.run`, `readme.notes` | Heading for the run command and closing paragraphs of `README.txt` |
| `validation` | Script, relative to the package, run as `node SCRIPT --executable PATH` on the extracted archive |
| `targets` | Release targets with their archive kind and executable name |

The package must have exactly one `bin` entry, `bin/<tool>.js`. Packaging runs
the package's `build` script when it has one, deploys it with `pnpm deploy
--prod`, keeps only the target's ONNX Runtime binding, downloads the Node
runtime pinned in `node-runtimes.json` and runs `<tool> download-models` into
`models/`.

From the repository root, install the frozen pnpm dependencies. Then run:

```bash
python3 exes/node-cli/scripts/portable_release.py package packages/topofit linux-x64
python3 exes/node-cli/scripts/portable_release.py verify packages/topofit linux-x64
```

Use `windows-x64` on Windows and `macos-arm64` on Apple silicon. A package can
only be built on its target operating system and architecture. Verification
extracts the archive, checks every file against `manifest.json`, runs
`self-check` and then the package's validation script, and writes a
`.validation.txt` receipt next to the archive in `exes/node-cli/dist/`.

`.github/workflows/node-cli-portable.yml` builds and verifies every target of
one package. `syncro-native.yml` and `topofit-native.yml` call it and can
attach the verified archives to an existing `syncro-vVERSION` or
`topofit-vVERSION` release.
