# @neurodesk/brainqcnet

BrainQCNet (Garcia, Dosenbach & Kelly, 2024) detects artifacts in T1-weighted
brain MRI. It classifies every slice along x, y and z as clean or showing
artifacts with a prototype network (ProtoPNet on ResNet152) and flags the image
when more than half of the slices are flagged.

This package runs the original BIDS app's preprocessing and summaries in
JavaScript. The classifier is injected, so the web app drives the ONNX export
(`model.manifest.json`) with ONNX Runtime Web.

```js
import { readVolume, runBrainQCNet, tableCsv } from '@neurodesk/brainqcnet';

const volume = await readVolume(bytes);
const { summary } = await runBrainQCNet(volume, { classify });
summary.pred; // 1 when artifacts are detected
tableCsv(summary); // table.csv as the BIDS app writes it
```

`validation/README.md` shows that the slice images, slice predictions and CSV
files equal the original Docker image's on the examples.

Garcia M, Dosenbach N, Kelly C. BrainQCNet: A Deep Learning attention-based
model for the automated detection of artifacts in brain structural MRI scans.
Imaging Neuroscience 2024; 2: 1–16. https://doi.org/10.1162/imag_a_00300
