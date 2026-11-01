# @neurodesk/greedy

Offline command-line distribution and browser wrapper for `exes/greedy`.
The package exposes the small affine/deformable registration pipeline and gzip
boundary helpers.

## Install the offline CLI

Download `neurodesk-greedy-VERSION.tgz` from the matching Greedy GitHub release,
then install the local file with Node.js 22 or later:

```bash
npm install --global --offline --no-audit --no-fund ./neurodesk-greedy-VERSION.tgz
greedy-rs --version
greedy-rs -d 3 -a -m NMI -i fixed.nii.gz moving.nii.gz -o affine.mat -ia-image-centers -n 100x50x10
```

The tarball bundles Linux x64, Windows x64 and Apple ARM executables. Execution
needs no model, network connection or compiler. The command accepts the same
flags as the [native CLI](../../exes/greedy/README.md). The signed and notarized
macOS installer is distributed separately as a `.pkg`.

To build a complete tarball, run the `greedy-native` workflow. Each platform
build stages its executable under `native/`; `npm pack` fails if any target is
missing. The workflow tests the installed tarball on all supported platforms
before attaching it to a release. The generated browser WASM runtime remains
in the web release, outside the npm package.

## Attribution

This package contains a minimal Rust/WebAssembly implementation of a subset of
the C++/ITK Greedy registration tool. Original Greedy was developed by Paul
Yushkevich at the Penn Image Computing and Science Lab and is maintained by the
Greedy open-source contributors. See the
[Greedy project history](https://sites.google.com/view/greedyreg/about) and
[upstream source](https://github.com/pyushkevich/greedy).

The published npm package includes its [NOTICE](./NOTICE), preserving this
attribution when the package is used outside the Neurodesk webapp.

The runtime directory must be served intact: its JavaScript, WebAssembly, and
`wasm-bindgen-rayon` worker helper use relative URLs and must remain adjacent.
The Greedy app stages that directory at build time and initializes it inside a
dedicated worker. Registration accepts uncompressed NIfTI bytes; callers use
`gunzip` before registration and `gzip` for downloadable output.

## Single-threaded build

`wasm-single/` is a second build of the same crate without threads, committed
so that every platform runs the same bytes. `@neurodesk/greedy/single` loads it
in Node (`loadGreedySingleThread()`), with the threaded build's exports except
`initThreadPool`; SYNcro's command line uses it. The core's reductions do not
depend on the thread count, and on a BISON T1 and template pair the threaded
build in Chromium and this build in Node gave byte-identical affine and warp
outputs. The native `greedy-rs` does not: its libm rounds differently, and the
same affine differed in the twelfth digit.

`src/worker.js` runs this build in a browser module worker (`affine` and
`rigid` requests), so a page and Node run the same bytes. BISON uses it for
its linear registrations; serve `src/` beside `wasm-single/`.

After changing `exes/greedy/core` or `exes/greedy/wasm`, rebuild it on Linux
and commit the result:

```bash
pnpm --filter @neurodesk/greedy build:wasm-single
```

LLVM folds math constants with the host's libm, so a build on another system
can differ. The `wasm-single` job in `greedy-native.yml` rebuilds it with
`--check` and fails when the committed files differ.

## Rebuild

From the repository root:

```bash
pnpm --filter @neurodesk/greedy build:wasm
pnpm --filter @neurodesk/greedy test
```

The build uses the pinned `nightly-2025-11-15` toolchain and writes the
generated runtime to the ignored `packages/greedy/wasm` directory. The
versioned `greedy-v…` GitHub Release includes it in the standalone web archive.
The deployed app serves that runtime from its own origin.
