# TVX format

TVX ("tract voxels") stores one or more tracts after their streamlines have been snapped
to the voxel grid of a reference NIfTI image. Each streamline becomes a run of voxel
indices. The expensive step (affine transform, rasterisation, bounds checks) is done once
at conversion; a lesion query is then a byte walk with no floating point, directly on the
file bytes.

## Layout

Little endian, 4-byte aligned. A file header followed by `ntract` records:

```
tvx_header      68 bytes
record[0]       tract_header 72 bytes, uint32 offsets[noffset], stream[nbytes] padded to 4
record[1]       ...
```

### tvx_header

| Offset | Type        | Field     | Meaning |
|-------:|-------------|-----------|---------|
| 0      | uint32      | signature | `0x0A585654` = bytes `T V X \n` |
| 4      | uint32[3]   | dim       | NIfTI `dim[1..3]` of the reference image |
| 16     | float32[4]  | srow_x    | NIfTI sform row 0 |
| 32     | float32[4]  | srow_y    | NIfTI sform row 1 |
| 48     | float32[4]  | srow_z    | NIfTI sform row 2 |
| 64     | uint32      | ntract    | number of records that follow |

`dim` and the sform are a fingerprint. A query image must match `dim` exactly and each
sform entry to within 1e-4 relative (absolute below 1.0), otherwise the reader refuses.
This is what guarantees the precomputed voxel indices are valid for the lesion image; the
tolerance only absorbs float32 round-trips through other tools.

### tract_header

| Offset | Type      | Field   | Meaning |
|-------:|-----------|---------|---------|
| 0      | char[64]  | name    | NUL-terminated tract name (TSV column header) |
| 64     | uint32    | noffset | streamlines + 1 |
| 68     | uint32    | nbytes  | length of the stream, before padding |

### offsets

CSR style, in **bytes** into the stream. Streamline `i` occupies
`stream[offsets[i] .. offsets[i+1])`. `offsets[0] == 0`, `offsets[noffset-1] == nbytes`.
Byte offsets let a reader skip the rest of a streamline as soon as it has hit the mask,
without decoding it.

### stream

Each streamline is independent: a uint32 absolute linear voxel index
`x + y*dim[0] + z*dim[0]*dim[1]` for its first voxel, then one code byte per further voxel,
each a delta from the previous voxel:

- codes `0..26`: the 27 offsets `code = (dx+1) + 3(dy+1) + 9(dz+1)` with
  `dx,dy,dz ∈ {−1,0,1}`. Code 13 (zero delta) is never written.
- code `27`: escape, followed by the delta as a zigzag LEB128 varint
  (`(d<<1) ^ (d>>63)`, 7 bits per byte, high bit set = more bytes follow, at most 5 bytes).
- codes `28..255` are invalid; a reader treats them as corruption.

Nearly every within-streamline step is a neighbour move, so a streamline costs 4 bytes plus
about one byte per voxel. The stream is padded with zero bytes to a multiple of 4 so the
next record's offsets are aligned.

Entries are produced by the converter as follows:

1. Each vertex is mapped to continuous voxel coordinates via `inverse(sform)`. TRK vertices
   are first mapped from TrackVis voxmm space (`vox_to_ras · diag(1/voxel_size)` with a −0.5
   voxel shift because TrackVis uses corner origin).
2. Every voxel crossed by the segment between consecutive vertices is emitted, using
   Amanatides–Woo grid traversal. Voxel `v` spans `[v−0.5, v+0.5)`, so a single vertex maps
   to the nearest voxel, matching `round()`.
3. Voxels outside `dim` are dropped. Vertices that are NaN, Inf or beyond ±1e6 voxels are
   skipped and break the streamline.
4. Consecutive duplicates are dropped. Non-consecutive revisits are kept.
5. Streamlines left with zero voxels are dropped entirely, so they do not appear in the
   denominator of the reported fraction.

Because of step 2 the voxel list is independent of the source step size: a 2 mm step on a
1 mm grid has no gaps, and diagonal steps do not cut corners.

### Packing

`nii2tvx -p atlas.tvx a.tvx b.tvx ...` writes one file whose records are the records of the
inputs, in order. All inputs must share `dim` and sform. Converting a TRK/TCK always
produces a one-record file named after the input.

### gzip

The command line reads gzipped files transparently. The WASM build takes uncompressed
bytes; the host gunzips (`DecompressionStream` or Node `zlib`) first. gzip roughly quarters
the file.

## Reading

Validation happens once in `tvx_open`: signature, record sizes against the buffer length,
NUL-terminated names, `offsets[0] == 0`, monotonic offsets ending at `nbytes`. Stream
contents are validated as they are walked: an index outside `dim` or a varint running past
the streamline end makes the query fail. There is no decoded copy; the query walks the
file bytes, so RAM is the file size.

## Query

For a binary mask `img` (any non-zero voxel counts):

```
hits = 0
for each streamline i:
    v = first voxel; loop: if img[v]: hits++, break; v += next delta until offsets[i+1]
return hits / (noffset - 1)
```

Output is the fraction of streamlines that touch the mask. A tract with no streamlines in
the volume reports `nan`.

## Core API (C and WASM)

```
tvx_t  *tvx_open(uint8_t *buf, size_t len)     takes ownership of buf; NULL if invalid
int     tvx_ntract(tvx_t*)
char   *tvx_name(tvx_t*, int k)
mask_t *mask_open(const uint8_t *nii, size_t len) uncompressed NIfTI-1; NULL if invalid
float   tvx_query(tvx_t*, int k, mask_t*)      fraction; -1 on grid mismatch or corrupt stream
void    tvx_close(tvx_t*), mask_close(mask_t*)
```

`make wasm` exports exactly these plus `malloc`/`free`; `wasm_demo.mjs` shows the calls
from Node. The command-line tool is the same functions wrapped in file reading.

## Reference numbers (HCP1065 atlas, MNI152 1 mm, 182×218×182, 87 tracts)

| | |
|---|---:|
| streamlines | 503 085 |
| voxel entries | 84.4 M |
| packed atlas on disk | 88 MB (1.04 bytes per entry) |
| packed atlas gzipped | 22 MB |
| source TRK | 1.7 GB raw, 588 MB zip |
| 20 lesions (18.7 k voxels each) against the packed atlas | 1.4 s |
| one lesion, process start to exit | 0.09 s |
| peak RSS | ≈ file size + mask |
| WASM module | 21 KB |
| conversion of the whole atlas | 4.3 s |

# Evaluation

## What it gets right

- **The core idea is sound and is the whole win.** Snapping to the grid once turns every
  later query into byte walks against a mask. This is why the tool does 87 tracts in tens
  of milliseconds while streamline-geometry tools take minutes.
- **Zero-copy.** The file is the in-memory structure. Load is a read, RAM is file size, and
  the WASM build has no decode buffer, which is what makes it viable on a phone.
- **Self-validating.** The grid fingerprint prevents silent wrong-space answers; structural
  checks at open and range checks during the walk reject corrupt files.
- **Self-describing.** Tract names travel in the file, so one packed atlas replaces a
  directory plus a naming convention, and a browser fetches one URL.
- **Compact.** About 1 byte per voxel entry, 20× smaller than the source TRK.

## Remaining weaknesses

1. **Forward layout scans the whole tract per query.** For the test lesion about 82 % of
   entries are visited, because every streamline that misses must be walked to its end.
   An inverted index (voxel → streamline ids) would touch ≈ 22× fewer entries and its cost
   scales with lesion size rather than tract size. Worth it only for whole-brain
   tractograms with millions of streamlines or very large cohorts.
2. **No spatial bounds.** A per-tract bounding box would let the query skip tracts that
   cannot intersect the lesion. Many tracts return exactly 0 for a typical lesion; today
   each still costs a full scan.
3. **qform-only masks are refused.** The check reads the sform only; an image whose grid
   is expressed solely through the qform fails even when it is the same grid. A
   qform-to-sform fallback or a resample-on-load step is the likely next request.
4. **Native endian only**, and record sizes are uint32, so a single tract is limited to
   4 GB of stream. Neither has bitten yet.

## Verdict

For the stated goal (hundreds of lesions in seconds against a bundle atlas, natively and
in a browser) the format meets the bar with margin. An inverted index is the next step only
if a workload with per-lesion time above tens of milliseconds actually appears.
