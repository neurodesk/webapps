# NODDI tensor FA correction: full GE validation, 25 October 2026

Evidence for [#600](https://github.com/neurodesk/webapps/issues/600). All four full-volume WLS/OLS
cases pass: corrected FA is finite and in [0,1], every browser output equals the corresponding CLI
output after NIfTI decompression, and every non-FA tensor map plus the mask is unchanged from the
old kernel. These are correctness observations, not timing benchmarks.

## Method and scope

Inputs are the original ds006837 sub-15464 HB (128×128×64×121) and MUSE (256×256×28×121)
acquisitions, not the vendor-check slabs. Both retain all 121 frames and original gradient files.
The unchanged tensor shell rule fits the ten b0 and eight b800 volumes; higher shells remain
excluded. WLS and OLS each ran through the actual Node command with --no-noddi, --tensor-fit
wls/ols, --threads 2 and a supplied mask, then the fresh production browser with equivalent
automation parameters. No AMICO/dmipy fit or GPU tractography claim is made.

The fixed production app and CLI use NODDI 0.6.20261025. The CLI source was copied into two isolated
temporary packages with identical JavaScript/dependencies and only the old/new WASM substituted. The
production app dist was copied before validation to avoid a concurrent build changing assets. The
served NODDI WASM equals the new CLI kernel. Scientific change: aab06fb27.

- Old WASM: 0c4583b44bc6406292e5fe8832c1ad22198697e9aaacf3c8dcea7024da328f37.
- New/served WASM: c50a0f7f41b5987a0de590f82db8b1750fd429595f933b9ca8c160b9c6e21182.
- Chromium: 156.0.8078.4; Node: v24.19.0.

The image/gradient bytes were rechecked against the previously acquired immutable source manifests
after the runs; mask bytes were checked before fitting. Input URLs, bytes and full hashes are
retained in the local report.

- ge-hb: image SHA-256 050fb9bc697508a57dfe53b5adcb2155be52e2d32c8c72f16b8583995ed29969, OpenNeuro ds006837 commit 83f5405ab25ee103bf3da06ae9c3ccfdef0d9626. Immutable image URL: https://s3.amazonaws.com/openneuro.org/ds006837/sub-15464/dwi/sub-15464_acq-hb_dwi.nii.gz?versionId=sgne3FbRi5.Jgi5.9fHIifSC.Y_1FwFK
- ge-muse: image SHA-256 215941a2f801cd5ba5a7d72bdf9a38beb817a9206a83f77c30302428f32fc791, OpenNeuro ds006837 commit 83f5405ab25ee103bf3da06ae9c3ccfdef0d9626. Immutable image URL: https://s3.amazonaws.com/openneuro.org/ds006837/sub-15464/dwi/sub-15464_acq-muse_dwi.nii.gz?versionId=ldTgsHTkeCgNZARPeYidR.vny59Pl2lh

The supplied masks are the actual full-volume mean-b0 MindGrab CPU masks from the vendor checks
(mindgrab 0.1.20260925), held fixed across both hosts and kernels:

- ge-hb: 3be7aa5d832576282b033a9436c2955fd57d755dbd36e970e79bb38966e2c235 (243577 voxels).
- ge-muse: 15f380a5f798a1e559ab860b5af7055cb156cbe473e29b22ff9cd988f0160fa6 (465953 voxels).

Their voxel counts differ slightly from the masks in the issue body (HB 243582, MUSE 465974).
Consequently MUSE old-FA>1 counts also differ slightly; this report identifies the exact masks
rather than treating those different selections as identical. No newly generated mask or cropped
input was substituted.

## Results

| Full input | Fit | Mask voxels | Old FA > 1 | New FA > 1 | Changed FA voxels | New maximum FA |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| ge-hb | wls | 243577 | 3227 | 0 | 12912 | 0.99441653 |
| ge-hb | ols | 243577 | 6265 | 0 | 20360 | 0.98685306 |
| ge-muse | wls | 465953 | 12351 | 0 | 26726 | 0.99120784 |
| ge-muse | ols | 465953 | 23632 | 0 | 40372 | 0.98717433 |

Every changed FA voxel became exactly zero; other FA values remained unchanged. The changed count
exceeds the old FA>1 count because an indefinite tensor can have FA≤1: the implemented rule checks
negative eigenvalues, rather than merely clipping high FA. There were no negative or nonfinite
corrected FA values.

For each of the four cases, all seven downloaded outputs (FA, MD, AD, RD, S0, principal direction
and mask) were nonempty and finite and matched the new CLI after decompression. The six non-FA
outputs matched the old CLI kernel byte for byte after decompression, including headers. Thus the
validation preserves the intentionally unconstrained non-FA maps; it does not zero MD/AD/RD or
change the tensor shell selection. Gzip container bytes are not the equivalence criterion.

## Evidence and limits

Local evidence: /storage/home/ubuntu/.tmp/issue600-ge-validation-20261025/report.json, the old/new
CLI output directories, production-browser downloads and completed screenshots. The scratch harness
is /storage/home/ubuntu/.tmp/issue600-ge-validate.mjs (SHA-256
647fd119353e1e0c1e936d634944e1925a6e610dd663cf03e9d9b1c12d2e5e00). The report inventories every
decompressed output hash and records the pinned input URLs/hashes, exact mask identities, parameters
and provenance. These are local evidence paths, not public artifact URLs. Large images and maps are
not stored in this repository.

The production browser served the frozen app dist on a separate loopback port. Three reported
logical cores bounded its fitting pool to two workers. No fallback mask inference or reduced-volume
substitute was used. This establishes the requested full GE tensor behavior with those fixed masks;
it is not a new independent microstructure reference, clinical validation, performance result, or a
general bound for other acquisitions.
## Recheck on main, 29 October 2026

The `noddi` command line at main 435c2bc8f (NODDI 0.6.20261027, WASM c50a0f7f…, equal to a rebuild
with Rust 1.98.0 and binaryen version_117) refitted the four cases with the same inputs and masks
(hashes above). For every case and every output, the decompressed bytes equal the 25 October fixed
CLI and browser downloads. FA ranges from 0 to the maximum in the table above, with no value above 1,
below 0 or nonfinite. The FA voxels that differ from the old kernel are all exactly zero.
MD, AD, RD, S0 and the direction map equal the old kernel's output. `validation/cli-check.mjs` passed all 50 checks against
`browser-reference.json`. `fa_boundary_is_a_strictly_negative_eigenvalue` in `exes/dwi/tensor` covers the rule's
boundary on `TensorFit` directly: zero and signed-zero eigenvalues stay valid ([1, 0, 0] gives 1), the smallest positive
third eigenvalue gives 1/√2 and the smallest negative gives 0.
