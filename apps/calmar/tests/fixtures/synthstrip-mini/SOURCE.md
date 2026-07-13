# SynthStrip parity-test fixture

`T1.nii.gz` is the **MNI152NLin2009cAsym 2 mm** structural template, fetched
via `nilearn.datasets.load_mni152_template(resolution=2)`.

- Shape: `99 × 117 × 95`, 2 mm isotropic.
- Intensities in `[0, 0.988]`, normalised by the upstream template release.
- Size: ~1.8 MB gzipped.
- License: the MNI152 templates are public-research-use derivatives of MNI/ICBM
  data; redistributable under the standard MNI/BrainWeb non-commercial-use
  terms. Cite Fonov et al. (2009/2011).

## Why an averaged template instead of a true single-subject T1

The original Phase 2a.1.4c plan called for one IXI subject (CC-BY-SA-3.0).
The IXI release ships only as a single 4-GB tarball — there is no per-subject
direct-download URL on `brain-development.org`. Rather than block the parity
test on tarball plumbing, this slice uses the MNI152 average — which is still
a real anatomical brain (averaged over many subjects), is byte-tiny, and
exercises every step of the SynthStrip pipeline (LIA reorientation, 1 mm
resample, conform/center-pad, ONNX inference, threshold, CC + fill, inverse
warp).

Caveat: the MNI152 2 mm template is already mostly skull-stripped, so the
parity test cannot meaningfully validate "removes large amounts of skull"
behaviour — it instead validates that the pipeline runs end-to-end on a real
brain and produces a plausible single-component mask. End-to-end
skull-stripping quality on raw clinical scans is the job of the Phase 2a.1.5
browser smoke test, which the user can drive with any T1 of their choice.

## Rebuild

`python3 build_t1.py` re-fetches the template and overwrites `T1.nii.gz`.
Re-run only if you intentionally change source data.
