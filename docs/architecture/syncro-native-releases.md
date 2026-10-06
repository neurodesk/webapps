# SYNcro portable releases

## Decision

SYNcro's Windows x64 and Linux x64 downloads are portable directories with a
small native launcher, a private checksum-pinned Node runtime, and the existing
JavaScript application tree. The launcher only locates the adjacent runtime and
forwards the user's arguments. The validated JavaScript pipeline remains the
sole scientific implementation.

This design was selected over Node's Single Executable Application format.
SYNcro must still ship ONNX Runtime's native addon, the ANTs JavaScript and
WebAssembly files, and the MNI template beside the executable. SEA would add
injection, signature mutation, CommonJS bootstrap, and Node-version-specific
loader rules without removing that external application tree.

The macOS arm64 download is an installer package with the same directory,
installed in `/usr/local/lib/neurodesk/syncro` with a `/usr/local/bin/syncro`
symlink. Every Mach-O file is signed with the hardened runtime. A release
installer is signed with a Developer ID and notarized by Apple.

The packager runs `syncro download-models` into the directory, so every
download includes the checksum-pinned models and runs offline from first use.

## Ownership

- `packages/syncro` owns the CLI, scientific pipeline, model cache, and
  `release.json`, the target names and run command the packager reads.
- `exes/node-cli` owns the launcher, private-runtime acquisition, dependency
  pruning, archive layout, checksums, manifests, and extracted-archive checks.
  It is shared with TopoFit and reads `packages/syncro/release.json`.
- `.github/workflows/syncro-native.yml` calls the shared
  `node-cli-portable.yml` workflow, which owns target runners and release
  permissions. Build jobs are read-only; only the final publisher may write.
- The shell's Standalone action renders SYNcro's downloads from
  `registry/standalone.json`, into which the standalone catalog automation
  imports each signed, verified release. `apps/syncro` has no download dialog
  of its own.

The version in `packages/syncro/package.json` is authoritative. Repository
tests require `apps/syncro/package.json` to agree with it because the generic
web release and native release attach assets to the same `syncro-vVERSION` tag.

## Archive contract

Each archive contains one top-level directory:

```text
syncro-VERSION-TARGET/
  syncro[.exe]
  runtime/node[.exe]
  app/bin/syncro.js
  app/dist/
  app/data/
  app/node_modules/
  licenses/
  LICENSE
  NOTICE
  README.txt
  manifest.json
```

The packager downloads an exact official Node distribution and checks its
committed SHA-256 before copying the runtime and license. It deploys the frozen
production dependency graph with optional ONNX Runtime downloads disabled,
keeps only the target's `napi-v6` CPU runtime, rejects foreign native payloads
and symlinks, and records every archived file in a sorted manifest. Archive
metadata is normalized so the same source and toolchain produce the same bytes.

The launcher never searches `PATH`. On Unix it replaces itself with the private
Node process; on Windows it returns the child process's exit status. It
preserves the caller's working directory, environment, standard streams, and
native argument strings.

## Verification

Each target is packaged and tested on its target GitHub runner. Verification
extracts the completed archive into a fresh path containing spaces and invokes
the extracted executable, never the staging tree. On macOS it installs the
package with `installer` and invokes `/usr/local/bin/syncro`. Every check runs
with an empty temporary `HOME`, `USERPROFILE` and XDG directories, and fails if
SYNcro writes there.

`syncro self-check` loads `onnxruntime-node`, creates a small tensor, verifies
the template and registration WebAssembly, imports the registration module,
and reports the actual Node executable path. Portable verification requires
that path to be inside the extracted private runtime. It also exercises help,
argument validation, output preservation, and the empty offline-cache boundary
without downloading models or running the multi-gigabyte scientific workflow.
Numerical validation remains the responsibility of the existing shared
pipeline validation.

Every build produces the archive, `<archive>.sha256`, and
`<archive>.validation.txt`. The publisher requires every target's set, rechecks
them, requires an existing `syncro-vVERSION` release whose tag points to the
workflow commit, and uploads only the allowlisted files with replace semantics.
The generic release workflow remains the sole creator of the release and web
archive; native publication is an idempotent follow-up.

## User interface

The bar's Standalone action lists the release downloads with their checksums
and the extraction or `installer` command from the shared catalog. Native
archives stay on GitHub Releases and do not increase the web bundle.

## Accepted tradeoffs

- The download is a multi-file directory rather than a literal single-file
  application, preserving normal ESM, native-addon, and filesystem semantics.
- A private Node runtime increases archive size but makes the user-facing
  command self-contained and repeatable.
- The initial Windows launcher may be unsigned. Published checksums establish
  integrity; Authenticode can be added later without changing the archive or
  runtime contracts.
- The macOS installer needs an administrator password because it writes to
  `/usr/local`. The Windows and Linux archives run from any directory.
- Only a signed run of `syncro-native.yml` (`sign_release`) publishes, so a
  release never carries the ad hoc signed test installer.
