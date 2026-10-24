# @neurodesk/bison

BISON brain tissue segmentation (Dadar and Collins 2021) and its BISON-WMH variant with white
matter hyperintensities (Dadar et al. 2017), shared by the [BISON web app](../../apps/bison) and the
`bison` command line. The package holds the pipeline:

- `src/preprocess.js`: denoising, N4, `volume_pol` and registration to ICBM 2009c;
- `src/features.js` and `src/classify.js`: the random forest features and the classifier;
- `src/outputs.js`: the downloads on the T1 grid;
- `src/assets.js` and `model.manifest.json`: the model pins.

The tools are injected: `src/browser.js` gives the web app's drivers, and `src/node.js` gives the
Node drivers. [docs/preprocessing.md](docs/preprocessing.md) maps every step to the upstream MINC
pipeline and gives the measured differences.

## Command line

```bash
bison --t1 T1w.nii.gz --output results            # BISON: 8 tissue classes
bison --t1 T1w.nii.gz --flair FLAIR.nii.gz --output results   # BISON-WMH: adds WMH
bison download-models
bison self-check
```

The command line writes the same files as the web app:
- `<T1>_bison-labels.nii.gz`;
- one `<T1>_bison-prob-<class>.nii.gz` for each class;
- `<T1>_bison-mask.nii.gz`.

A run takes about 15 to 20 minutes and 3 GB of memory on 8 cores.

The trained classifiers, priors, histograms and average FLAIR are held until the BISON authors
allow their publication. Until then, give a local copy with `--asset-dir DIR` or `BISON_ASSET_DIR`.
`validation/cli-check.mjs` holds the command line to the web app's files, which a browser recorded
in `validation/browser-reference.json`:
- the labels and the mask must be byte for byte the same;
- the mean of each probability map must agree within 1e-6.

The probability maps are not byte for byte the same: ONNX Runtime Web and ONNX Runtime for Node add
the forest's votes in a different order, so a voxel can differ by up to 4.2e-7. On both examples the
means agree within 8e-10, and the labels and mask are identical. Rerecord the reference with
`apps/bison/e2e/pipeline.spec.js` (`BISON_BROWSER_OUTPUT=DIR`, `@slow`), then
`node validation/browser-reference.mjs --from DIR`.

There is no release archive yet. `release.json` comes after the model files are published.

## Validation

`validation/native/` runs the upstream BISON and BISON-WMH scripts on the MINC toolkit. On five
OpenNeuro ds007522 subjects, the labels agree with that reference in 0.933 to 0.944 of the voxels.
`test/pipeline-native.test.js` holds those gates.

WMH is the class that agrees least, with Dice 0.77 to 0.93. The FLAIR bias correction is N4, not
the native N3 (`nu_correct`), and this causes most of the difference. We accept this difference,
see [N4](docs/preprocessing.md#n4).
