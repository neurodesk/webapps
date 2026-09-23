# @neurodesk/nii2tvx

Structural disconnection in the browser: open a TVX tract atlas once, then query a lesion mask
against every tract. The engine is `exes/nii2tvx` compiled to WebAssembly — 21 KB, no
filesystem, no zlib, no `main` — so this package owns decompression, the memory rules and the
number formatting.

```js
import { openAtlas, toTsv } from '@neurodesk/nii2tvx';

const atlas = await openAtlas(atlasBytes);        // .tvx, gzipped or not
const fractions = await atlas.query(lesionBytes); // .nii or .nii.gz, on the atlas grid
const tsv = toTsv(atlas.tracts, [{ id: 'sub-01', fractions }]);
atlas.close();
```

`query` returns one float per tract: the fraction of that bundle's streamlines passing through
the lesion. `NaN` means the bundle has no streamlines inside the volume, which is missing data
rather than a failure. A lesion on a different grid throws with the reason the C core printed.

`toTsv` reproduces the CLI's table byte for byte, which is why `formatG` reimplements C's
`printf("%g")` instead of using `Number.toPrecision`: the two disagree on `nan` versus `NaN`,
on `3.24086e-05` versus `0.0000324086`, and on `1e-07` versus `1e-7`. The first of those is
what one clipped streamline of the largest HCP1065 bundle produces, so it is not academic.

Measured on an Apple M4 Pro with the 87-tract HCP1065 atlas: 13 ms to open the 88 MB atlas,
9 ms to open a mask, 57 ms for all 87 queries.

## The committed module

`wasm/nii2tvx.{mjs,wasm}` is checked in because no CI runner has emscripten, the same choice
`packages/registration` and `packages/synthseg` make. Rebuild it with `make wasm`, which runs
emcc in `exes/nii2tvx` and copies the result here. `npm test` fails if the committed module
stops agreeing with the native tool, so the artifact cannot drift from the C unnoticed.
