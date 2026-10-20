# dwi-ec-distortion

Eddy-current distortion correction for SHORELine (prototype, #481).

The diffusion gradients induce eddy currents. Their field shifts the image along the phase-encoding (PE) axis by a different amount in each volume.
SHORELine's affine registration absorbs only the linear part of that shift.
FSL eddy models the field of each volume as a polynomial in position (`--flm linear` or `quadratic`) and constrains the fields across volumes with a second-level model (`--slm linear`) (Andersson and Sotiropoulos 2016, NeuroImage 125:1063-1078).
This crate is a clean-room implementation of that model from the paper; no FSL code was read.
It fits each volume against SHORELine's 3dSHORE leave-out prediction (`dwi-shore`).

The crate is a prototype: the `hmc` app and command line do not use it until it passes a gate that the maintainer accepts (#481).

## Model

- `Field`: one coefficient (Hz) per term of `Model::Linear` (1, x, y, z) or `Model::Quadratic` (also x², y², z², xy, xz, yz). Coordinates are scaled to -1..1 between the first and last voxel centre of each axis, so a coefficient is the field at the edge of the grid. A complete linear or quadratic polynomial is the same function space in any rotated frame, so voxel axes lose nothing against scanner axes.
- The field moves the signal at voxel x to x + d(x) along the PE axis, d = sign · total readout time · field, in voxels. `Field::correct` gives `J(x) · observed(x + d(x))` with the exact Jacobian `J = 1 + ∂d/∂PE` of the polynomial.
- `fit`: the field whose correction is closest to the prediction over the brain mask, by Gauss-Newton with analytic derivatives and a step-halving line search. Resampling is along the PE lines only, with cubic convolution (Keys, a = -0.5).
- `second_level` with `SecondLevel::Linear` or `SecondLevel::Quadratic`: eddy's `--slm linear` and `--slm quadratic`. Each coefficient, across the volumes, is a function of q = gradient direction · √(b / b_max): q_x, q_y and q_z, plus q_x², q_y², q_z², q_x q_y, q_x q_z and q_y q_z for `Quadratic`; neither has a constant term. `Quadratic` needs at least 9 volumes whose directions determine it.
- `relax`: moves `omega` of the way from the previous iteration's fields.

One SHORELine iteration: predict every volume from the others (3dSHORE), `fit` each volume, `second_level` (use `Linear`; see below), `relax` with `omega` = 0.65.
`Geometry` takes the PE axis, its sign and the total readout time; the `hmc` integration gets them from BIDS or datain with `dwi-pe-field` (#479).

## Why the second-level model and the relaxation

Measured on the synthetic SHORELine loop below:

- Without the second-level model, the part of the field that is the same in every volume drifts: it moves every prediction with it, so the data cannot fix it. The mean displacement error went 0.58, 0.36, 0.27, then up again to 0.44 voxels after 8 iterations.
- Each volume is fitted against predictions from volumes that are still distorted, and its antipodal neighbours are distorted the opposite way, so a full step overshoots by about 1.55 and the estimates alternate. `omega` = 0.65 removes most of that; with it the loop converges in 2 to 3 iterations instead of 7 or more. The value is tuned on the phantom; the ADNI comparison will check it.
- The gradient directions must cover the whole sphere. On a half sphere, the neighbours of a direction share its distortion, the 3dSHORE prediction carries it, and the fit finds almost nothing to correct (the error stayed at 0.56-0.59 voxels). eddy's documentation gives the same condition for `--slm`.

## `--slm quadratic` with 3dSHORE predictions

The quadratic second-level model adds terms that are even in the gradient direction.
The 3dSHORE basis is antipodally symmetric, so the prediction for direction g treats g and -g as one signal.
An odd field part is distorted the opposite way at -g, so it cancels in the prediction and the fit sees it.
An even field part is the same at g, at -g and at their neighbours, so the prediction carries it and the fit cannot see it.
On the synthetic loop, `Quadratic` still corrects most of the distortion, but it is less accurate than `Linear`, it drifts slowly, and it does not recover even parts:

| Fields | `--slm linear`, iterations 1-3 | `--slm quadratic`, iterations 1-3 |
| --- | --- | --- |
| Odd in the gradient | 0.024, 0.016, 0.013 voxels | 0.077, 0.077, 0.087 voxels |
| With an even part of 15 % | 0.080, 0.078, 0.077 voxels | 0.091, 0.096, 0.110 voxels |

Without the isotropic combination q_x² + q_y² + q_z² (which is constant within a shell) the result is the same, so the cause is the symmetry, not that term.
Physical eddy-current fields are odd in the gradient (they scale with its amplitude and change sign with it), which is why `Linear` is the default here, as in QSIPrep's eddy settings and the ADNI3 runs.

## Tests

`tests/synthetic.rs` uses phantoms that are continuous functions of position, distorted exactly: each output voxel's source position comes from Newton's method, so only the fit's own interpolation is approximate.

| Check | Result (displacement RMS error in the brain) |
| --- | --- |
| Known quadratic field (largest shift 2.4 voxels), true image as the prediction | 0.010 voxels; 0.011 with noise σ = 12 |
| The same distortion with a linear model | 0.30 voxels, residual 370 times larger |
| SHORELine loop: 70 volumes (b = 1000 x 30, 2000 x 40, whole sphere), fields odd in the gradient and scaled with √b, 3dSHORE predictions | 0.58 before; 0.024, 0.016, 0.013 after iterations 1-3 |
| The same with an even part of 15 %, which `--slm linear` cannot represent | 0.58 before; 0.077 after 3 iterations |
| Both cases with `--slm quadratic` | see the table above |

## Differences from eddy

- eddy predicts with a Gaussian process per shell; this crate uses the 3dSHORE leave-out prediction.
- eddy estimates movement and eddy currents together; here the field is fitted after SHORELine's affine registration. The constant and linear terms overlap with the affine's translation, scale and shear along the PE axis.
- `--sep_offs_move` and the field's dependence on head position are not implemented.

## Comparison with eddy (planned)

A native harness runs SHORELine with this crate on two local ADNI3 sets that were also run through FSL eddy 6.0.7.7 (`--flm=quadratic --slm=linear`; reverse-PE topup and Synb0-DisCo topup; 20 sessions each).
It reports, per set, the median absolute PE-displacement difference from eddy's eddy-current field in the brain, and the white-matter FA and MD differences against eddy, with and without this model.
ADNI data cannot be shared; only aggregate numbers will go here and into #481.
Proposed promotion gate: median PE-displacement difference <= 0.2 voxel, and an FA difference from eddy smaller than with SHORELine's affine alone.
