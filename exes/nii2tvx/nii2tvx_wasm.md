# nii2tvx in the browser: handoff

For the developer building the WASM package and the web page. Read `tvx_format.md` for
the file format; this document is about the runtime surface, the data flow, and the traps.

## What you get from `make wasm`

`nii2tvx.mjs` (Emscripten loader, ES module) and `nii2tvx.wasm` (21 KB). The module
exports seven C functions (open, count, name, query and close for the atlas; open and
close for the mask) plus `malloc`/`free`, and the runtime helpers `HEAPU8` and
`UTF8ToString`. Nothing else: no filesystem, no zlib, no `main`. Requires `emcc`
(Homebrew `emscripten`); the makefile target is the single source of truth for flags.

`wasm_demo.mjs` is the reference client. It reproduces the native tool's TSV from Node and
is the check to run after any change: its numbers must equal `./nii2tvx lesion atlas.tvx`.

## The API

```
ptr   = _tvx_open(buf, len)      // buf: malloc'd bytes of a .tvx file. Ownership moves to C.
n     = _tvx_ntract(ptr)
name  = UTF8ToString(_tvx_name(ptr, k))
mask  = _mask_open(nii, len)     // nii: malloc'd bytes of an UNCOMPRESSED NIfTI-1. Copied, free it after.
frac  = _tvx_query(ptr, k, mask) // float: 0..1, -1 on error, NaN for an empty tract
        _mask_close(mask); _tvx_close(ptr)
```

Return conventions:

- `_tvx_open` and `_mask_open` return 0 on failure and print the reason to stderr, which
  Emscripten routes to `console.error`. Nothing else signals the cause. To capture it,
  pass `printErr` when instantiating (`createModule({ printErr: line => ... })`).
- `_tvx_query` returns `-1` for "grid mismatch" or "corrupt stream" and prints which. A
  `-1` for one tract means every tract in that file will return `-1`.
- `NaN` is not an error: the tract had no streamlines inside the volume.

Calling pattern per session: open the atlas once, open a mask per lesion, run `ntract`
queries, close the mask. The atlas stays open for the life of the page.

## Memory rules

- `HEAPU8` is a view over WASM memory that is **replaced** whenever memory grows
  (`ALLOW_MEMORY_GROWTH=1`). Never cache it across a call that allocates; always read
  `Module.HEAPU8` fresh before `set` or `subarray`. `wasm_demo.mjs` does this inside
  `toHeap`.
- `_tvx_open` keeps the buffer you pass and frees it in `_tvx_close`. Do not free it
  yourself. `_mask_open` copies out of its buffer; free that one immediately.
- Resident memory is the atlas bytes plus one mask (7 MB for the 1 mm MNI grid) plus the
  transient uncompressed NIfTI while `_mask_open` runs. 88 MB atlas → about 110 MB. There
  is no decoded copy of anything.
- WASM32 addresses 4 GB; the atlas is nowhere near that. If a whole-brain tractogram
  bundle ever exceeds 2 GB, the `len` arguments (`size_t`, 32-bit here) still work but
  browsers may refuse the allocation. Not a concern for bundle atlases.

## Data flow for the page

1. **Atlas.** Host `hcp1065_avg_tracts.tvx` (88 MB; 22 MB gzipped). Two options:
   - Serve it with `Content-Encoding: gzip` and `fetch` it; the browser inflates.
   - Serve `hcp1065_avg_tracts.tvx.gz` and inflate with
     `new DecompressionStream("gzip")`. Use this if the CDN will not negotiate encoding.

   Cache the inflated `ArrayBuffer` in the Cache API or IndexedDB keyed by a version
   string; the format signature does not carry a version, so key on the file name or an
   ETag. Fetch once per page load at most.
2. **Lesion.** The user's mask must already be on the atlas grid (MNI152 1 mm,
   182×218×182, FSL sform). Inputs arrive as `.nii` or `.nii.gz` bytes; gunzip in JS, then
   `_mask_open`. Any non-zero voxel is lesion; datatypes uint8, int16, uint16, float32.
   NIfTI-2, big-endian, other datatypes, and qform-only headers are refused with a
   console message.
3. **Query.** `ntract` calls to `_tvx_query`. Native cost is about 65 ms for all 87 tracts;
   expect 100 to 200 ms in WASM. Run it in a Web Worker so the UI thread stays free, and
   post the row back as `{name, fraction}` pairs.
4. **Output.** Column names come from `_tvx_name`; the native TSV header is
   `id\t<name>...`. Keep the same order so results are comparable with the CLI.

## Grid tolerance

The header check compares `dim` exactly and each sform entry to within 1e-4 relative
(absolute below 1.0). That absorbs float32 round-trips through other tools, and rejects a
0.05 % scale or a 0.02 mm shift. A mask that fails the check with a header that "looks the
same" is almost always a qform-only file or a different template variant (2 mm, or a
non-FSL MNI). Resampling to the template in the browser is out of scope for the core;
`niimath`'s WASM build can do it upstream if needed.

## Threads

The core is stateless apart from the two handles. Opening one atlas and querying it from
several workers at once is safe as long as each worker has its own module instance (WASM
memory is per instance; there is no shared-memory build). Simplest: one worker, sequential
lesions.

## Verifying a build

```
make wasm
node wasm_demo.mjs example/wM2208_T1w_lesion.nii.gz hcp1065_avg_tracts.tvx > wasm.tsv
./nii2tvx example/wM2208_T1w_lesion.nii.gz hcp1065_avg_tracts.tvx > native.tsv
```

The two files must agree to six significant digits on every column. The three lesions in
`example/` cover a big, a small, and a zero-overlap case for most tracts.

## Things not to do

- Do not decode the file into JavaScript arrays. The point of the byte layout is that the
  C walker runs on the file bytes; a JS port would need the same 27-code decoder and would
  be slower for no gain.
- Do not pass a `.nii.gz` to `_mask_open`; it does not inflate.
- Do not rely on `HEAPF32` or other views that were not exported; add them to
  `EXPORTED_RUNTIME_METHODS` in the makefile if a future API needs them.
- Do not add file-reading or zlib calls above `#ifndef __EMSCRIPTEN__` in `nii2tvx.c`;
  that boundary is what keeps the module at 21 KB and filesystem-free.
