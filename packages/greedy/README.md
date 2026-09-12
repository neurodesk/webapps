# @neurodesk/greedy

Browser wrapper for the threaded WebAssembly build of `exes/greedy`.
The package exposes the small affine/deformable registration pipeline and gzip
boundary helpers.

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
