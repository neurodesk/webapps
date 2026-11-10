# NODDI toolbox 1.05 port

`dwi-noddi-toolbox` ports the NODDI toolbox 1.05 fit (Zhang et al. 2012) of the in-vivo model
`WatsonSHStickTortIsoV_B0`. The `noddi` app offers it as the "NODDI toolbox" fit beside the AMICO default.
`packages/noddi` runs it from `noddi.wasm` (`toolbox_new`, `toolbox_fit`, `toolbox_free`).

The model and the fit are the toolbox's `MakeModel('WatsonSHStickTortIsoV_B0')` defaults:

- intra-axial diffusivity 1.7 µm²/ms and isotropic diffusivity 3.0 µm²/ms, both fixed;
- tortuosity; b0 fixed at the mean b0 signal;
- sigma per voxel;
- the two-stage fit (`noOfStages = 2`, no MCMC).

## Licence

The toolbox is distributed under the Artistic License 2.0. Every file that ports it carries
`SPDX-License-Identifier: Artistic-2.0`, and `LICENSE-NODDI-TOOLBOX` holds the licence and the
toolbox's notice. The toolbox's bundled `NODDI_erfi.m` has no licence. It is not ported or
mirrored. `erfi` is `dwi-amico`'s independent positive power series, and `tests/special.rs`
holds it and the Rician likelihood's ln I0 to 50-digit mpmath values (`tools/special_values.py`).
The toolbox archive is not in this repository.

## Ported files

The source is `NODDI_toolbox_v1.05.zip` from NITRC, SHA-256
`d4f8a1fe5c5e038a29174c40c4f6de0c868728e4d4cdf59c1d7f6dd399ca8143`.

| Toolbox file | Port |
| --- | --- |
| `FSL2Protocol.m` | `Protocol::new` |
| `MakeModel.m`, `GetSearchGrid.m`, `GetScalingFactors.m`, `GradDescLimits.m` | the constants in `src/lib.rs` |
| `ThreeStageFittingVoxel.m`, `RemoveNegMeas.m`, `EstimateSigma.m` | `fit_voxel` |
| `GridSearchRician.m`, `FitLinearDT.m`, `DT_DesignMatrix.m` | `fit_voxel`, `linear_tensor` |
| `GradDescEncode.m`, `GradDescDecode.m` | `encode`, `decode` |
| `fmincon_fix.m`, `fobj_rician_fix.m`, `fobj_rician.m`, `fobj_rician_st.m` | `minimize` and the objective in `fit_voxel` |
| `SynthMeasWatsonSHStickTortIsoV_B0.m` and the files it calls: `SynthMeasWatsonSHCylSingleRadTortIsoV_GPD(_B0).m`, `SynthMeasWatsonSHCylSingleRadTortGPD.m`, `SynthMeasWatsonSHCylSingleRadGPD(_PGSE).m`, `SynthMeasWatsonSHCylNeuman_PGSE.m`, `CylNeumanLePar_PGSE.m`, `CylNeumanLePerp_PGSE.m` (R = 0), `SynthMeasWatsonHinderedDiffusion_PGSE.m`, `SynthMeasHinderedDiffusion_PGSE.m`, `SynthMeasIsoGPD.m` | `synth` |
| `WatsonSHCoeff.m`, `LegendreGaussianIntegral.m`, `WatsonHinderedDiffusionCoeff.m` | `src/watson.rs` |
| `RicianLogLik.m`, `logbesseli0.m` | `src/rician.rs` |
| `GetFibreOrientation.m`, the ODI of `SaveParamsAsNIfTI.m` | `Fit::direction`, `Fit::odi` |

## Differences from the toolbox

- **Optimizer.** The toolbox calls `fmincon` with the active-set algorithm. The pinned reference
  ran it as optim 1.6.3's SQP in Octave. This port minimises the same objective, with the same
  parameter encoding, bounds and free parameters per stage, using L-BFGS-B (`dwi-gp`, a port of
  SciPy's). Gradients are central differences.
  - Each stage runs until its line search cannot lower the objective (`ftol` 0, at most 1000
    iterations). The toolbox's `TolFun` of 1e-6 is absolute on a likelihood of order 1e5 to 1e6.
    SciPy's relative default stopped short of the toolbox's optimum in 1548 of the gate voxels.
  - A non-finite objective ends the voxel with error code 2, as `FunValCheck` does.
  - `Fit::converged` is false when a stage stops at the iteration limit. The toolbox does not
    read fmincon's exit flag, and the result is kept.
- **Special functions.** `NODDI_erfi.m` is not ported (see Licence). Below 700, `logbesseli0`
  takes ln I0 from `rician::log_i0`, not from MATLAB's `besseli`.
- **Precomputation.** The terms of the fixed di and diso are computed once per gradient table:
  the Legendre-Gaussian integrals of the stick and the isotropic signal. The gradient descent
  decodes di and diso from their square roots, so it keeps its own copy of these terms at the
  decoded values, as the toolbox evaluates them.
- **Tensor fit.** `FitLinearDT` takes `pinv(X) * log(E / S0)`. The port computes the same
  minimum-norm solution from an SVD of X itself (one-sided Jacobi), dropping singular values
  at or below `pinv`'s tolerance, so a rank-deficient design (for example, only axial or only
  oblique samples left positive) still gives the minimum-norm start. The fibre direction is the eigenvector of the
  eigenvalue largest in magnitude, and its sign is `dwi-tensor`'s convention. The model depends
  on the direction only through cos²; the starting angles depend on the sign.
- **Input checks.** The protocol needs a b0 volume and a non-zero b-vector for every other
  volume. `FSL2Protocol` falls back to zero-length b-vectors when no b-value is at or below the
  threshold; this port does not. The app passes its own b0 set (b < 50 s/mm²) as the threshold.
  The reference used `FSL2Protocol`'s default of 0, which gives the same b0 volumes on its data.
- **App outputs.** `noddi.wasm` writes zeros for a voxel with error code 1 (no positive b0, or
  fewer than six positive diffusion-weighted samples) and counts it as skipped. The toolbox's
  maps hold ODI 1 there. For error code 2, the maps keep the grid-search start, as in the toolbox.

## Validation

`validation/` holds the pinned #424 reference: toolbox 1.05 in Octave 11.3.0, on the
ds005134 slab. The gate (#425) uses the maintainer's WM mask: the MindGrab brain mask AND
FA ≥ 0.4, without the toolbox's 14 error-code-2 voxels, which leaves 13,327 voxels. For ICVF,
ISOVF and ODI, the median absolute difference to the toolbox maps must be below 0.02. The
gate compares with the toolbox reference only, never with AMICO.

```bash
python3 exes/dwi/noddi-toolbox/validation/fetch_reference.py "$TMPDIR/noddi-toolbox-reference"
python3 exes/dwi/noddi-toolbox/validation/prepare_reference.py \
  "$TMPDIR/noddi-toolbox-reference" "$TMPDIR/noddi-toolbox-prepared"   # numpy, nibabel
cd exes/dwi
NODDI_TOOLBOX_PREPARED="$TMPDIR/noddi-toolbox-prepared" \
  cargo test --release -p dwi-noddi-toolbox --test reference -- --nocapture
cd ../..
NODDI_TOOLBOX_PREPARED="$TMPDIR/noddi-toolbox-prepared" \
  node exes/dwi/noddi-toolbox/validation/wasm-reference.mjs
```

Without `NODDI_TOOLBOX_PREPARED`, the Rust test skips. The `toolbox-reference` job of
`dwi-native.yml` sets `NODDI_TOOLBOX_REQUIRE_REFERENCE=1`, which turns the skip into a failure.
That job also runs the committed `noddi.wasm` through the same gate.

The table gives the absolute difference to the toolbox on the 13,327 gate voxels. The WASM
reads float32 input and writes float32 maps, so its numbers differ slightly from the native
build's.

| Map | Native median | WASM median | 95th percentile | Max (native, WASM) |
| --- | --- | --- | --- | --- |
| ICVF | 3.25e-6 | 3.28e-6 | 1.8e-5 | 0.104, 0.104 |
| ISOVF | 3.39e-6 | 3.39e-6 | 9.5e-6 | 0.103, 0.110 |
| ODI | 3.96e-7 | 3.95e-7 | 1.5e-6 | 0.990, 0.990 |

In 260 voxels of the native build, a map differs by more than 0.01. In 251 of them, the toolbox reached a higher
likelihood. Most of these voxels start the descent with fiso or ficvf at 0. The encoding
`asin(√f)` has zero slope there, and Octave's SQP leaves that point more often than L-BFGS-B.

`tests/fixture.rs` and `packages/noddi/test/toolbox.test.js` fit 12 gate voxels without a
download (`tests/fixtures/voxels.json`, `tools/fixture.py`; the inputs and maps are CC0). They
hold the native port to the toolbox within 1e-3 on all twelve, and the WASM on eleven: voxel
(19, 59, 5) starts at fiso = 0, and there the WASM's last-bit math differences reach another
optimum.

The WASM fit takes about 15 ms per voxel on one thread. The toolbox in Octave took 2.8 s.
