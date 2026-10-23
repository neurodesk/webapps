# dwi-pe-field

Susceptibility fields along the phase-encoding (PE) axis, for SHORELine head motion correction with a topup field (#479).
The crate turns topup output into the displacement and the intensity weights that the `hmc` resampling applies, in one resampling with the motion transforms.
It reads no files: volumes are flat arrays in NIfTI voxel order (x fastest), as `readNiftiFrames` returns them.

| Part | Source | Licence |
| --- | --- | --- |
| `topup`: the field (Hz) of a topup coefficient file | clean-room, from the file header and topup's own output | Apache-2.0 |
| `displacement`: `PhaseEncoding`, `displacement_lps` | QSIPrep 26.1.1 `TopupFieldToWarp` (`interfaces/fmap.py`), plus FSL's x-axis convention | BSD-3-Clause ([LICENSE-QSIPREP](LICENSE-QSIPREP)) |
| `jacobian`: `jacobian_pe`, `modulation_weights` | QSIPrep 26.1.1 `jacobian_determinant` (`interfaces/jacobian.py`) | BSD-3-Clause |

`TopupField::new` chains the three on the grid topup ran on.

## topup coefficient files

topup writes its field as cubic B-spline coefficients (`--out` gives `*_fieldcoef.nii.gz` and `*_movpar.txt`).
This crate evaluates them without FSL code.
The format below comes from the file header and from fits to the field that topup writes with `--fout`:

- NIfTI `intent_code` 2016 ("FSL topup cubic spline"). `pixdim` 1-3 is the knot spacing in voxels of the image grid topup ran on; `intent_p1-3` is that grid's voxel size in mm.
- An axis of N voxels with knot spacing k ≥ 2 has ⌊N/k⌋ + 3 coefficients, and knot j is at voxel (j - 1)·k. With k = 1 (a warp resolution as fine as the voxels, as in some ADNI sessions) it has N coefficients, and knot j is at voxel j.
- The field at a voxel is the tensor product of centred cubic B-splines of width 4k on the knots. When N is not a multiple of k, the last voxel reaches one knot past the grid; that coefficient counts as 0.
- The voxel axes are FSL's. FSL works in radiological voxel order, so for an affine with a positive determinant it counts x from the other end. The datain vectors use the same axes.
- The coefficient file does not store the image grid. `TopupCoefficients::evaluate` takes it and refuses a grid that the coefficients do not fit.

The field belongs to topup's first input volume: that volume's `movpar` row is always zero, so this crate does not read `movpar`.
In the ADNI3 pipeline the first input is volume 0 of the DWI series (a b0).
The `hmc` package places the field with that volume's b0-stage transform (#479).

## Displacement and Jacobian

A voxel moves `Hz · TotalReadoutTime` voxels along the first datain row's direction.
`displacement_lps` returns the ITK displacement field that unwarps the image (LPS mm, output point to input point), as `TopupFieldToWarp` writes it.
The step goes to world space through the grid's affine, so an oblique grid works.
QSIPrep always gives topup an LAS+ image (negative determinant) and does not need FSL's x flip; this crate applies it, so both handednesses work, and on a negative-determinant grid it equals QSIPrep.
`PhaseEncoding::from_bids` converts BIDS `PhaseEncodingDirection` (the file's voxel axes) to datain axes.

`jacobian_pe` is TORTOISE's Jacobian as QSIPrep computes it: `1 + d(u_PE)/d(PE)`, central differences along the PE voxel axis, with the two edge slices set to 1.
`modulation_weights` gives |J| and counts the folded voxels (J <= 0), which QSIPrep reports.

## Parity

| Comparison | Gate | Result |
| --- | --- | --- |
| Field from the coefficients against topup `--fout`, radiological grid, knot spacing 2 (`tests/topup.rs`) | 1e-6 of the largest field | 5.4e-8 |
| The same, neurological grid (x flipped), knot spacing 3, axes not multiples of k | 1e-6 | 4.5e-8 |
| The same without the x flip | must miss | misses |
| Unwarping displacement against the distortion the fixture applied, both handednesses | r > 0.8 | 0.98 and 0.89 |
| Displacement against `TopupFieldToWarp`, axis-aligned and oblique grids (`tests/oracle.rs`) | 1e-6 of the largest | 4.7e-8 and 6.6e-8 |
| Jacobian weights against `jacobian_determinant`, both grids | 1e-5 | 1.2e-7 |

The differences are float32 rounding: topup and QSIPrep store float32.

`tools/topup_reference.py` writes `tests/fixtures/topup.json`: two synthetic AP/PA b0 pairs distorted with a known field, run through FSL 6.0.7.7 `topup` with a short two-level schedule.
FSL is a reference tool here; its code is not ported.
`tools/oracle.py` writes `tests/fixtures/qsiprep.json` from QSIPrep 26.1.1's own `TopupFieldToWarp._run_interface` and `jacobian_determinant`, taken unchanged from a checkout.
Both outputs are deterministic.

```bash
FSLDIR=... PATH=$FSLDIR/bin:$PATH python -I tools/topup_reference.py WORK tests/fixtures/topup.json
python -I tools/oracle.py QSIPREP tests/fixtures/topup.json tests/fixtures/qsiprep.json
cargo test -p dwi-pe-field -- --nocapture
```

Use the QSIPrep container's numerical stack for `tools/oracle.py` (see `exes/dwi/shore/README.md`).

## Not here

- Field maps that are not topup output (for example a BIDS GRE field map in Hz). QSIPrep sends those through `FieldmapToVSM` and `FUGUEvsm2ANTSwarp`, which differ from the topup path: the shift is `Hz · EffectiveEchoSpacing · N_PE`, which is N/(N - 1) times `Hz · TotalReadoutTime`; the sign is opposite for a positive PE direction; and the voxel axis is used as the world axis, which ignores obliquity. Which convention is physically right for a GRE field map needs a reference run first; it is a later issue.
- The alignment of the field to the b0 template and the resampling, which belong to the `hmc` package (#449, #479).
