# nii2tvx and disconnectome instructions

- `exes/nii2tvx` is the C tool (the first non-Rust entry in `exes/`); `apps/disconnectome`
  is its web front end. `nii2tvx.c` is split by `#ifndef __EMSCRIPTEN__`: above it the query
  core, buffer in and numbers out, no file I/O and no zlib, which is the whole 21 KB WASM
  surface; below it file reading, TRK/TCK conversion and `main`. Keep that boundary or the
  browser build grows a filesystem.
- The browser owns gzip (`DecompressionStream`); `mask_open` takes uncompressed NIfTI bytes.
- The TSV must match the CLI byte for byte, so JavaScript formats fractions with a `%g`
  reimplementation, not `toPrecision`: the two differ on `nan`/`NaN`, on `3.24086e-05` versus
  `0.0000324086`, and on `1e-07` versus `1e-7`. `make test` enforces it.
- Lesions must sit on the atlas grid (MNI152 1 mm, 182x218x182, sform). The app refuses
  anything else and points at SYNcro, which normalizes to exactly that template.
- The display TRX and the query TVX are different files on purpose: numbers come from the
  full-resolution atlas, geometry from a decimated copy. `apps/disconnectome` says so in
  About; keep that distinction if either file changes.
- Two atlases ship, ENIGMA Symmetric (65 bundles, the default) and HCP1065 (87). They are
  different parcellations, so a result cannot be carried across a switch and the saved TSV
  names the atlas. `models/disconnectome.manifest.json` holds the pairing under `atlases`.
- Build an ENIGMA-style TVX from a 1 mm source, never a 2 mm one: `nii2tvx` rasterizes each
  segment with Amanatides-Woo, so 2 mm chords cut corners into voxels the streamline never
  enters. Measured, that doubled a small deep lesion's score and made the file larger.
- `@neurodesk/nii2tvx` decodes tract names itself rather than calling `UTF8ToString`: past
  16 bytes Emscripten switches to `TextDecoder`, which the browser refuses on the resizable
  ArrayBuffer behind a growable WASM memory. HCP1065's short names never hit it; ENIGMA's do.
- Every remote asset is checksummed against the manifest, the display TRX included: it is
  fetched through `fetchModel` and handed to NiiVue as an object URL rather than by URL, so
  the mesh parser never sees unverified bytes. `fetchModel` also re-verifies on a cache hit.
- The TVX supplies the numbers and the TRX the colours, keyed by bundle name, and the two are
  built by different scripts from different source trees. `make test-real` diffs the two name
  sets; if they ever drift the app colours nothing while every number stays right.
- `_malloc` returns 0 rather than aborting in this build, so the wrapper checks it: an
  unchecked `HEAPU8.set` at address 0 corrupts the module instead of failing.
- NiiVue rc.13 is required, not the rc.11 most apps pin: `setTractOptions`'s
  `groupColors` (colour and visibility per TRX group, in one call) and `dps` arrived in rc.13.
  The 3D clip plane is load-bearing, not decoration: without it the opaque volume render hides
  every bundle inside the brain.
- The Standalone bar action belongs to the shell and renders `registry/standalone.json`; an app
  cannot replace it with its own dialog. Every registered app needs an entry there or the
  catalog check fails.
- The `disconnectome` command line is `packages/nii2tvx/bin/disconnectome.js`. It shares the
  row id, file name and grid refusal with the app through `@neurodesk/nii2tvx/disconnectome`, and
  ships a copy of `models/disconnectome.manifest.json` that its tests require to be identical;
  `repoint_manifest.sh` writes both. Its release check compares each example's table with the
  committed native goldens in `exes/nii2tvx/test`.
- Examples are declared once, in `apps/disconnectome/examples.json`, which the shared
  `nd-example-selector` downloads and checksums. Re-pinning the dataset changes every URL, so
  after `repoint_manifest.sh` run `apps/disconnectome/scripts/sync-examples.mjs` and then
  `scripts/lock-example-assets.mjs`, dropping the old revision's entries from the offline
  inventory first.
