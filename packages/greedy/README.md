# @neurodesk/greedy

Browser wrapper and committed threaded WebAssembly build for `exes/greedy`.
The package exposes the small affine/deformable registration pipeline, gzip
boundary helpers, and the generated `wasm-bindgen` runtime directory.

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
generated runtime to `packages/greedy/wasm`. These files are committed and are
included in package releases, matching the repository convention used for
other browser-owned WASM modules. The webapp does not download executable code
from Hugging Face or GitHub releases; those services hold datasets and native
release archives respectively.
