# nii2tvx

`nii2tvx` is a command-line tool for estimating structural disconnection from voxel-based lesion maps.
It creates **TVX** files from streamline data (`.trk` or `.tck`) and computes overlap between binary lesion masks and TVX files.  
By identifying which fiber bundles are intersected by lesions, it highlights likely disruptions to white matter pathways and their relation to impairment and recovery.

## Features

- Convert streamline files (`.trk` or `.tck`) to compact `.tvx` format.  
- Compute the fraction of streamlines intersecting a lesion mask.  
- Supports `.nii` and `.nii.gz` NIfTI images.  
- Handles both TRK and TCK tractography formats.  

## In this repository

Upstream is [neurolabusc/nii2tvx](https://github.com/neurolabusc/nii2tvx); this is the copy
the Neurodesk catalog builds from. The browser app `apps/disconnectome` runs the same query
core compiled to WebAssembly, so a lesion analysed in the browser and one analysed here
produce the same numbers.

```bash
cd exes/nii2tvx
make            # native tool
make wasm       # nii2tvx.mjs + nii2tvx.wasm (needs emcc)
make test       # committed fixtures, plus WASM parity when the module is built
make test-real  # the two real atlases and four examples; NII2TVX_REFERENCE_DIR points at the data checkout
make sanitize   # ASan + UBSan build as nii2tvx_asan
```

`make test` converts four small bundles against a 20 mm template, packs them, and queries two
lesions. The bundles are chosen so the answers span a full hit, a fraction, a miss and an
empty tract (`nan`); a fixture that only produced 0 and 1 would pass with the middle of the
algorithm broken. It also checks that the packed atlas and the per-tract files agree, that a
lesion on a different grid is refused, and that the WASM module prints exactly what the native
tool prints. Conversion regressions cover padded TCK headers, malformed TCK vertices and truncated TRK records.
Allocation tests inject failures into each query-core allocation and check cleanup. Measured here: 57 ms for all 87 HCP1065 tracts in WASM, 13 ms to open the 88 MB
atlas, 9 ms to open a mask.

## Manual Usage

### 0. Compile nii2tvx

```bash
make
```

### 1. Create TVX files from streamline data

```bash
./nii2tvx template.nii tracks1.tck tracks2.tck
./nii2tvx template.nii tracks1.trk
```

- `template.nii`: NIfTI image defining voxel space and affine transform.  
- `tracksX.trk` / `tracksX.tck`: tractography files. TCK inputs must use inline `Float32LE` data;
  the converter respects the header's `file: . <offset>` and rejects unsupported encodings.
- Output: `.tvx` files, one per input streamline file.  
- Pack many into one self-describing atlas: `./nii2tvx -p atlas.tvx tracks1.tvx tracks2.tvx`  
- Format details: [tvx_format.md](tvx_format.md).  

### 2. Compute lesion overlaps with TVX files

```bash
./nii2tvx lesion.nii atlas.tvx
./nii2tvx lesion1.nii lesion2.nii tracks1.tvx tracks2.tvx
./nii2tvx ./imgs/w*lesion.nii.gz atlas.tvx > results.tsv
```

- `lesionX.nii`: binary lesion masks.  
- `atlas.tvx` / `tracksX.tvx`: precomputed TVX files, one column per tract they contain.  
- Output: TSV table of lesion–tract overlap fractions.  

## Automated TVX creation

The script `hcp2tvx.py` downloads the [HCP1065 Population-Averaged Tractography Atlas](https://brain.labsolver.org/hcp_trk_atlas.html) TRK files and converts them to match the template `MNI152_T1_1mm_brain_mask.nii.gz`.  
You can adapt the script for other templates or streamlines.

```bash
python hcp2tvx.py
```

This creates one `tvx` file per tract in `hcp1065_avg_tracts_tvx/` and packs them all into `hcp1065_avg_tracts.tvx`.
`enigma2tvx.py` does the same for the [ENIGMA Symmetric atlas](https://zenodo.org/records/19656193), which the
Neurodesk app offers by default; unpack that download first and pass its directory. Use its 1 mm full set, not
the 2 mm one — see the script's docstring for why.

```bash
python3 enigma2tvx.py ~/src/ENIGMA_atlas
```

`make test-real` and `packages/nii2tvx/test/parity.test.js` both read `NII2TVX_REFERENCE_DIR` (default
`~/src/nii2tvx`) and expect it to hold `hcp1065_avg_tracts.tvx`, `enigma_symmetric.tvx` and an `examples2/`
directory of lesion/scan pairs, which the two scripts above and the Neurodesk Hugging Face dataset provide.

Use `lesion2tvx.py` to compute overlaps, providing a folder of TVX files and a folder of lesions:

```bash
python lesion2tvx.py ./lesions ./hcp1065_avg_tracts_tvx > results.tsv
```


## Example Usage

Consider the lesion map `wM2208_T2w_lesion.nii.gz` that has been spatially normalized to the `MNI152_T1_1mm_brain_mask.nii.gz` template. We can identify the proportion damage to all the HCP1065 tracts.

```
nii2tvx ./examples2/wM2208_T2w_lesion.nii.gz hcp1065_avg_tracts.tvx > M2208.tsv
```
This will generate a tab-separated values file.



## Output Format

Example TSV table:

```
id    tract1    tract2    ...
lesion1    0.25    0.10    ...
lesion2    0.30    0.05    ...
```

- `id`: lesion identifier.  
- Remaining columns: fraction of streamlines intersecting each tract.  

## Build Instructions

Optimized build:

```bash
gcc -O3 nii2tvx.c -o nii2tvx -lz -lm
```

Or use the Makefile:

```bash
make          # optimized build
make sanitize # ASan + UBSan build as nii2tvx_asan
make wasm     # nii2tvx.mjs + nii2tvx.wasm (needs emcc); try: node wasm_demo.mjs lesion.nii.gz atlas.tvx
```

## WebAssembly

The query core has no file I/O, so it compiles to a 21 KB WASM module exposing seven functions (tvx_open, tvx_close, tvx_ntract, tvx_name, tvx_query, mask_open, mask_close). A page fetches one packed atlas and gunzips it and the lesion in JavaScript; see `wasm_demo.mjs` for the calls and [nii2tvx_wasm.md](nii2tvx_wasm.md) for the integration handoff.

## Alternatives, References and Links

- [HCP1065 Population-Averaged Tractography Atlas](https://brain.labsolver.org/hcp_trk_atlas.html), described by [Yeh, PMID: 35995773](https://pubmed.ncbi.nlm.nih.gov/35995773/).  
- [TRACULA (TRActs Constrained by UnderLying Anatomy)](https://pmc.ncbi.nlm.nih.gov/articles/PMC3193073/).  
- White matter atlas underlying the [Disconnectome Studio](http://165.232.73.88/) ([PMID: 18619589](https://pubmed.ncbi.nlm.nih.gov/18619589/)).  
- [Network Modification Tool (NeMo)](https://pubmed.ncbi.nlm.nih.gov/23855491/) [GitHub link](https://github.com/kjamison/nemo).  
- [Lesion Quantification Toolkit](https://pubmed.ncbi.nlm.nih.gov/33813262/) (archived).  
- Early descriptions: [Rudrauf et al., 2008](https://pubmed.ncbi.nlm.nih.gov/18625495/).  

## Why use nii2tvx?

Other toolkits exist, but `nii2tvx` offers flexibility (easy atlas building) and speed (compact binary format for fast computations).  
