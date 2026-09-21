# Disconnectome (web)

Score which white-matter bundles a lesion disconnects. The app intersects a lesion map with the
87-bundle HCP1065 population-averaged tractography atlas and reports, per bundle, the fraction
of streamlines passing through the lesion. Everything runs in the browser: the arithmetic is
`exes/nii2tvx` compiled to WebAssembly, through `@neurodesk/nii2tvx`.

## The workflow

1. Choose an example pair, or drop a lesion map with an optional anatomical scan. The smaller
   NIfTI is taken as the lesion, since a mask compresses far smaller than the scan it was drawn
   on; a name containing `lesion`, `mask` or `roi` settles it outright. With no anatomical
   scan, the MNI152 template SYNcro ships stands in as the backdrop.
2. Look at the lesion in red at 70 % over the scan.
3. **Generate disconnectome** downloads the atlas once (21.8 MB gzipped, cached afterwards) and
   scores all 87 bundles in about 60 ms.
4. The bundles appear coloured by viridis over their damage. The slider hides bundles below a
   threshold and re-spreads the ramp from the threshold to 100 %, so raising it uses the whole
   colormap on what remains. A clip plane opens the volume: without it the opaque 3D render
   hides every bundle inside the brain.
5. **Download disconnectome (.tsv)** writes the command-line tool's own table, byte for byte.

## Numbers and picture come from different files

Fractions are computed on the full-resolution atlas, so a browser result equals `nii2tvx` on
the command line to six significant digits; the e2e suite asserts exactly that against the
CLI's committed output. The streamlines drawn are a separate, decimated file: 20 % of each
bundle at 3 mm point spacing, 18.9 MB rather than 1.23 GB. Do not count fibres on screen and
expect the reported fraction.

## Grid

A lesion must be on the atlas grid, MNI152 1 mm, 182 × 218 × 182, sform. Anything else is
refused with the reason and a pointer to [SYNcro](../syncro/), which normalizes to exactly that
template. The app never resamples a lesion silently.

```bash
pnpm --filter disconnectome dev
pnpm --filter disconnectome test
pnpm --filter disconnectome lint
pnpm --filter disconnectome build
pnpm --filter disconnectome test:e2e          # shell and refusal paths, no large downloads
DISCONNECTOME_LIVE_DATA=1 pnpm --filter disconnectome test:e2e   # adds the real atlas run
```

Assets are pinned by commit in `models/disconnectome.manifest.json`; `exes/nii2tvx/scripts/repoint_manifest.sh`
re-pins them after an upload. The example pairs are declared in `examples.json`, which the shared
`nd-example-selector` downloads and checksums, and which `scripts/lock-example-assets.mjs` mirrors
into the offline inventory.
