# Philips and GE DWI vendor checks

These checks address [#419](https://github.com/neurodesk/webapps/issues/419)
and [#420](https://github.com/neurodesk/webapps/issues/420). They test loading,
processing and output on the requested public acquisitions. They apply no
numeric image-quality gate.

## Inputs and metadata

The Philips source is ds007522 sub-HML0001 ses-01 at
[commit cf13f9c](https://github.com/OpenNeuroDatasets/ds007522/tree/cf13f9c73a5488a0796dcb0588e75066538f9363/sub-HML0001/ses-01/dwi).
The GE source is ds006837 sub-15464, with both HB and MUSE acquisitions, at
[commit 83f5405](https://github.com/OpenNeuroDatasets/ds006837/tree/83f5405ab25ee103bf3da06ae9c3ccfdef0d9626/sub-15464/dwi).
The [source manifest](../../validation/dwi-vendors/sources.json) pins the
sidecars and gradients to those commits and the NIfTI objects to S3 version
IDs. Each NIfTI SHA-256 also matches its git-annex key at the recorded commit.
All input files were downloaded and checked against their recorded size and
SHA-256. Data and generated outputs stay on the storage volume.

| Field | Philips | GE HB | GE MUSE |
| --- | --- | --- | --- |
| Scanner | Ingenia Elition X | Discovery MR750 | Discovery MR750 |
| Dimensions | 128 × 128 × 69 × 136 | 128 × 128 × 64 × 121 | 256 × 256 × 28 × 121 |
| Voxel size, mm | 1.8125 × 1.8125 × 2 | 1.7188 × 1.7188 × 1.7 | 0.8594 × 0.8594 × 1.7 |
| PhaseEncodingDirection | `j` | `j-` | `j-` |
| SliceEncodingDirection | absent | absent | absent |
| NIfTI slice dimension | 2, zero based | 2, zero based | 2, zero based |
| TotalReadoutTime, seconds | 0.0332897 | 0.04788 | 0.036036 |
| Stored datatype | int16 | int16 | int16 |
| `scl_slope` | 39.07523727416992 | 1 | 1 |
| `scl_inter` | 0 | 0 | 0 |
| b-values, s/mm² × volumes | 0 × 1; 1 × 11; 500 × 12; 1000 × 48; 2000 × 64 | 0 × 10; 800 × 8; 1500 × 32; 2500 × 71 | 0 × 10; 800 × 8; 1500 × 32; 2500 × 71 |
| dcm2niix version | v1.0.20220720 | v1.0.20230411 | v1.0.20230411 |

The Philips b = 1 volumes count as b0 under the apps' 50 s/mm² threshold,
giving 12 b0 volumes. All supplied bvec files have three FSL rows and one
column per volume. Non-b0 vector norms lie between 0.9999992 and 1.0000007.
No manual transpose or sign change was applied. All three NIfTI affines have
LAS voxel axes and negative determinants. `PartialFourier` is absent in all
three sidecars. Degibbs therefore uses its default in-plane axes 0,1, which
agree with the NIfTI slice dimension.

## Execution status

The full Philips NODDI command-line run completed with the original
128 × 128 × 69 × 136 image and unaltered gradients. Version 0.4.20261024
ran WLS tensor fitting and AMICO NODDI on two workers. The default MindGrab
0.1.20260925 CPU mask contained 206,569 voxels. All 11 output NIfTIs were
finite. This process loaded the completed-batch source subsequently committed
as `e004a2e64`, before the later main merge.

The remaining checks use central 64 × 64 × 10 spatial slabs, retaining every
diffusion volume. The crop tool verifies unchanged stored int16 voxel values
and `scl_slope`, byte-identical gradients and both translated coordinate
transforms. It crops an actual full-volume mean-b0 MindGrab mask to the same
box. GE HB's full mask contains 243,577 voxels; GE MUSE's contains 465,953.
These runs establish slab execution and do not claim full-volume GE processing.

| Slab | Source voxel ranges, stop excluded | Volumes |
| --- | --- | --- |
| Philips | x 32:96, y 32:96, z 29:39 | 136 |
| GE HB | x 32:96, y 32:96, z 27:37 | 121 |
| GE MUSE | x 96:160, y 96:160, z 9:19 | 121 |

| Application | Philips | GE HB | GE MUSE |
| --- | --- | --- | --- |
| NODDI browser | passed, slab | passed, slab | passed, slab |
| NODDI command line | passed, full volume | passed, slab | passed, slab |
| Degibbs browser | passed, slab | passed, slab | passed, slab |
| Degibbs command line | passed, slab | passed, slab | passed, slab |
| Dwidenoise browser | passed, slab | passed, slab | passed, slab |
| N4 browser | passed, slab | passed, slab | passed, slab |

Dwidenoise and N4 currently have no command-line entry point in their packages.
All 18 checks completed with their expected outputs. NODDI ran both the tensor
and NODDI models on every acquisition. No processing failure or uncaught
browser error occurred, and no application defect was found.

Browser checks used Chromium 156.0.8078.4 with the software WebGL2 viewer
fallback. Tested browser versions were NODDI 0.5.20261024, Degibbs
0.4.20261024, Dwidenoise 0.3.20261024 and N4 0.5.20261024. Reports retain
the source commit, every served application file's hash, the actual operation
report, downloaded artifact hashes and screenshots. Large files remain under
`$TMPDIR/vendor-dwi-check`; `summary.json` indexes the completed checks.

The unconstrained Philips WLS fit produces FA above 1 in 399 of the 206,569
masked voxels, with maximum 1.2247425. The tensor implementation explicitly
allows negative eigenvalues for poor fits. This is recorded without imposing
an FA quality gate. ICVF ranges from 0 to 0.99000001.

Philips browser FA and ICVF match the corresponding full command-line outputs
at every one of the slab's 40,960 voxels. Degibbs's browser and command-line
NIfTIs are byte-identical after decompression, as are their bval, bvec and
sidecar outputs. The Philips input's physical mean is 8143.758, compared with
stored-int16 mean 208.412; the Degibbs output mean is 8140.204 with unit slope.
This confirms the reader applies the Philips slope instead of processing the
unscaled stored values.

For both GE acquisitions, browser and command-line Degibbs outputs are
byte-identical after NIfTI decompression, including the unchanged gradients
and sidecar. NODDI FA, ICVF and mask downloads are likewise byte-identical
after decompression. All produced NIfTI frames were checked for finite values;
the browser's required outputs and the gradients' unchanged hashes were
verified against each run's report and pinned input files. Desktop screenshots
of the completed Philips and GE workflows were reviewed.

## Reproduce

Use an installed workspace and a current composite production build from
`pnpm build`. Choose a storage
directory, acquire the checksummed inputs, then run one app at a time:

```sh
node scripts/validation/dwi-vendors.mjs acquire --dir "$TMPDIR/vendor-dwi-check"
node --expose-gc scripts/validation/dwi-vendors.mjs prepare-mask \
  --dir "$TMPDIR/vendor-dwi-check" --case ge-hb
python3 scripts/validation/crop-dwi-vendors.py --dir "$TMPDIR/vendor-dwi-check" \
  --case ge-hb --mask "$TMPDIR/vendor-dwi-check/ge-hb/sub-15464_acq-hb_desc-brain_mask.nii.gz"
node scripts/validation/dwi-vendors.mjs run --dir "$TMPDIR/vendor-dwi-check" \
  --case ge-hb --app degibbs --slab
node scripts/validation/dwi-vendors.mjs run-cli --dir "$TMPDIR/vendor-dwi-check" \
  --case ge-hb --app noddi --slab
```

Cases are `philips`, `ge-hb` and `ge-muse`; apps are `noddi`, `degibbs`,
`dwidenoise` and `n4`. The crop tool requires NiBabel and NumPy. `--slab`
selects the derived inputs and their verified matching mask.
`--cores 3` reports three logical cores to Chromium, leaving two NODDI fitting
workers after the app reserves one for its interface. The first Philips
browser run used `--cores 2`, hence one fitting worker; no timing comparison
is made.
`--mask /absolute/path/to/mask.nii.gz` supplies an
already generated brain mask to NODDI or N4. The driver uses the actual
production app and automation operation, records its report and browser
errors, downloads representative scientific outputs and verifies their
hashes and every image frame. It writes reports, images and screenshots
under the selected storage directory. It never substitutes a test executor.
