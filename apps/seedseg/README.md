# Prostate gold seed segmentation

SeedSeg detects gold fiducial markers in T1-weighted prostate MRI. The browser
and portable command line use the same scientific pipeline in
[`packages/seedseg`](../../packages/seedseg/README.md).

The default is nnU-Net v2 network 1, without test-time mirroring. Select all five
networks for the upstream evaluated ensemble. Advanced settings retain the
legacy v1 four-network 3D U-Net consensus. Browser inference tries WebGPU first
and retries a failed network on WebAssembly. The command line runs on the CPU.

From the repository root, run:

```sh
pnpm --filter seedseg dev
pnpm --filter seedseg build
pnpm --filter seedseg test
pnpm --filter seedseg test:e2e
```

<<<<<<< monorepo
The development server listens on port 8080 with cross-origin isolation. The
build stages the shared components, scientific package and checksum-pinned
ONNX Runtime 1.30.0 and QSM WASM files. Models and the inference WASM binary download on first use through
the shared verified cache. The pinned binary stays outside the site artifact
because it exceeds the hosting per-file limit. Their URLs, sizes and SHA-256 hashes are recorded in
`models/seedseg.manifest.json` and the offline inventories.

V2 crops to nonzero voxels, normalizes, resamples when needed, and runs Gaussian
sliding windows with optional mirroring. It averages per-fold probabilities,
then ranks 26-connected marker candidates by mean probability. Output NIfTI
files retain the input grid and affine. The detection report contains marker
ranks, probabilities, volumes, weighted centroids and a count flag.

This ports [upstream commit c9b328a](https://github.com/astewartau/prostate/tree/c9b328a2e0bc1768c0b75640f5532e2853e7ef31).
Training and evaluation code remains upstream. Both local adapters use QSM
homogeneity correction, while training used N4. Off-protocol resampling uses
linear interpolation, as in the upstream browser. These choices need clinical
validation against the upstream reference; software parity alone does not
establish clinical accuracy. The app has no public example because the existing
synthetic fixture is unsuitable as an example.

For offline installation, options, output names and validation commands, see
the [command-line reference](../../packages/seedseg/README.md). Cite the methods
from the shared application bar.
=======
Outputs: `results/sub_marker_prob.nii.gz` and `results/sub_detections.json` (top-K markers with mean probability, centroid in voxel and world coordinates, and `count_flag` when fewer than K candidates were found).

Tests (wiring only, tiny data): `pytest scripts/deploy/tests` and `node --test web/tests/*.test.mjs`.

## Training and evaluation (nnU-Net model)

| Folder | Contents |
|---|---|
| `scripts/labels/` | Reference labels from the clinical DICOM data, and automatic labels from planning CT ([README](scripts/labels/README.md)) |
| `scripts/nnunet/` | nnU-Net dataset conversion, cross-validation splits, training and probability export ([README](scripts/nnunet/README.md)) |
| `scripts/evaluation/` | Marker detection evaluation: top-K candidates, one-to-one matching within 5 mm, confidence intervals, paired comparisons |
| `scripts/deploy/` | ONNX export and the ONNX Runtime inference pipeline used by the web app and the OpenRecon container |
| `scripts/paper/` | Manuscript figures |
| `scripts/synth/`, `scripts/rerank/` | Synthetic marker insertion and candidate re-ranking |
| `scripts/demo/` | Synthetic demo cases without patient data, as in the Hugging Face dataset [ash347/seedseg-demo](https://huggingface.co/datasets/ash347/seedseg-demo) used by the web app's example button ([README](scripts/demo/README.md)) |

Patient identifiers in these files are replaced by study codes (S001–S127, E01–E09).

## Citation

Stewart et al. "Deep-Learning-Enabled Differentiation between Intraprostatic Gold Fiducial Markers and Calcification in Quantitative Susceptibility Mapping." bioRxiv (2023). https://doi.org/10.1101/2023.10.26.564293
>>>>>>> upstream
