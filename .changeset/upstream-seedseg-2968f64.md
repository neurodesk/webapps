---
"seedseg": patch
---

Merge upstream astewartau/prostate c9b328a..2968f64:

- web: Load example data button (synthetic demo case from Hugging Face)
- web: pin example data to seedseg-demo commit d48dd5d
- web: load dicompare on first use so its host cannot stop the app booting
- web: example button loads the case once; re-enable only after a failed download
- demo: synthetic demo cases from population anatomy and appearance models
- demo: lazy pydicom import, GPU batch size 2 in the gate
- demo: package selected cases (NIfTI, DICOM, labels, truth); save detections and error analysis in the gate
- demo: dataset card
- demo: use scripts/deploy/seedseg_onnx.py instead of a copy; README with steps and results
- demo: re-centre sampled anatomy on its prostate; plausibility floor in the safe gate; README numbers
- Merge pull request #4 from astewartau/fix-dicompare-lazy
- Merge pull request #5 from astewartau/example-data
- Merge pull request #6 from astewartau/demo-synth
