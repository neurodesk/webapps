#!/usr/bin/env python3
"""
gen_golden.py -- generate golden-file checkpoints for the Rust port (milestone M0).

Runs the *validated* Python pipeline (mp2rage_t1) on a small, fully deterministic
synthetic MP2RAGE + SA2RAGE phantom and dumps every intermediate array the Rust
core must reproduce, as .npy, plus a manifest.json. No PHI, safe to commit.

The Rust parity test (crates/mp2rage-core/tests/parity.rs) loads these and asserts
numpy-allclose. The phantom NIfTIs are also written so the native CLI (M2) can be
diffed against the Python CLI on the same data.

Run:  python tools/gen_golden.py     (needs numpy, scipy, nibabel, and mp2rage_t1)
"""
from __future__ import annotations
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, REPO)                       # import the in-repo package

from mp2rage_t1 import model as M               # noqa: E402
from mp2rage_t1 import pipeline as P            # noqa: E402
import nibabel as nib                           # noqa: E402
import scipy                                    # noqa: E402

OUT = os.path.join(HERE, 'golden')
PHA = os.path.join(HERE, 'phantom')
os.makedirs(OUT, exist_ok=True)
os.makedirs(PHA, exist_ok=True)

MANIFEST = {'numpy': np.__version__, 'scipy': scipy.__version__,
            'nibabel': nib.__version__, 'checkpoints': {}}


def save(name, arr):
    """Save a checkpoint .npy and record its shape/dtype/fingerprint."""
    arr = np.asarray(arr)
    path = os.path.join(OUT, name + '.npy')
    np.save(path, arr)
    a = arr.astype(np.float64) if arr.dtype != bool else arr.astype(np.float64)
    finite = np.isfinite(a)
    MANIFEST['checkpoints'][name] = {
        'shape': list(arr.shape),
        'dtype': str(arr.dtype),
        'n_nan': int(np.isnan(a).sum()) if arr.dtype != bool else 0,
        'sum': float(a[finite].sum()) if finite.any() else 0.0,
        'min': float(a[finite].min()) if finite.any() else 0.0,
        'max': float(a[finite].max()) if finite.any() else 0.0,
    }
    print(f"  {name:28s} {str(arr.shape):18s} {arr.dtype}")


# ---------------------------------------------------------------------------
# Sequence parameters (7T MP2RAGE + SA2RAGE, same as the reference dataset)
# ---------------------------------------------------------------------------
MP = dict(B0=7.0, TR=4.3, TIs=(0.840, 2.370), FlipDegrees=(5.0, 6.0),
          NZslices=(64, 128), TRFLASH=7.0e-3, inv_eff=0.96)
SA = dict(TR=2.4, TRFLASH=5.0e-3, TIs=(0.150, 1.500), FlipDegrees=(6.0, 6.0),
          NZslices=(24, 24), averageT1=1.5)
INV_EFF = 0.96
MANIFEST['MP2RAGE'] = {k: (list(v) if isinstance(v, tuple) else v) for k, v in MP.items()}
MANIFEST['SA2RAGE'] = {k: (list(v) if isinstance(v, tuple) else v) for k, v in SA.items()}


# ===========================================================================
# 1. Deterministic unit checkpoints (isolate each ported kernel)
# ===========================================================================
print("[1] unit kernels")

# mprage_signal over a T1 vector (the Bloch model)
T1vec = np.arange(0.05, 5.0 + 1e-9, 0.05)
S1, S2 = M.mprage_signal(MP['TR'], MP['TIs'], MP['NZslices'], MP['TRFLASH'],
                         MP['FlipDegrees'], T1vec, INV_EFF)
save('u_mprage_S1', S1)
save('u_mprage_S2', S2)

# MP2RAGE UNI lookup (monotonic branch)
lut_I, lut_T = M.mp2rage_lookuptable(MP['TR'], MP['TIs'], MP['FlipDegrees'],
                                     MP['NZslices'], MP['TRFLASH'], INV_EFF)
save('u_mp2rage_lut_I', lut_I)
save('u_mp2rage_lut_T', lut_T)

# SA2RAGE ratio lookup
sa_B1, sa_I = M.sa2rage_lookuptable(SA['TR'], SA['TIs'], SA['FlipDegrees'],
                                    SA['NZslices'], SA['TRFLASH'], SA['averageT1'])
save('u_sa2rage_lut_B1', sa_B1)
save('u_sa2rage_lut_I', sa_I)

# PCHIP in isolation (Fritsch-Carlson) -- top numeric risk
px = np.array([0.0, 0.5, 1.0, 2.5, 3.0, 5.0])
py = np.array([0.0, 0.3, 0.35, -0.2, -0.5, 0.8])
pq = np.linspace(-0.5, 5.5, 41)
save('u_pchip_x', px)
save('u_pchip_y', py)
save('u_pchip_q', pq)
save('u_pchip_out', M._pchip_safe(px, py, pq))

# np.interp on a decreasing-x table (used by t1_from_uni)
save('u_interp_dec_out', M._interp_decreasing(lut_I, lut_T, np.linspace(-0.6, 0.6, 51)))

# T1(B1, UNI) lookup table (PCHIP inversion over the B1 grid)
B1_vec, MP_vec, _fT1 = M._build_mp2rage_t1_lookup(MP, INV_EFF)
save('u_build_B1_vector', B1_vec)
save('u_build_MP2RAGE_vector', MP_vec)
# reconstruct the T1matrix itself (the interpolator wraps it) for a table-level check
T1_vec = np.arange(0.5, 5.2 + 1e-9, 0.05)
MP2RAGEmatrix = np.full((B1_vec.size, T1_vec.size), np.nan)
for k, b1val in enumerate(B1_vec):
    I, T = M.mp2rage_lookuptable(MP['TR'], MP['TIs'], b1val * np.asarray(MP['FlipDegrees']),
                                 MP['NZslices'], MP['TRFLASH'], INV_EFF)
    MP2RAGEmatrix[k, :] = np.interp(T1_vec, T, I, left=np.nan, right=np.nan)
T1matrix = np.zeros((B1_vec.size, MP_vec.size))
for k in range(B1_vec.size):
    T1matrix[k, :] = M._pchip_safe(MP2RAGEmatrix[k, :], T1_vec, MP_vec)
T1matrix = np.nan_to_num(T1matrix, nan=4.0)
save('u_T1matrix', T1matrix)

# separable gaussian filter (sigma=1) on a small 3D volume
rng = np.arange(6 * 5 * 4, dtype=np.float64).reshape(6, 5, 4)
gvol = np.sin(rng) + 0.5 * np.cos(2 * rng)
from scipy.ndimage import gaussian_filter, binary_closing, binary_fill_holes
save('u_gauss_in', gvol.astype(np.float32))
save('u_gauss_out', gaussian_filter(gvol.astype(np.float32), 1.0))
# f64 gaussian (store precision path used by the SA2RAGE branch of pipeline.py)
save('u_gauss64_in', gvol)
save('u_gauss64_out', gaussian_filter(gvol, 1.0))

# binary morphology: closing(iterations=2) then fill_holes  (the brain_mask tail)
mvol = np.zeros((10, 9, 8), dtype=bool)
mvol[2:8, 2:7, 2:6] = True
mvol[4, 4, 3] = False           # interior hole
mvol[3, 5, 4] = False
mvol[5, 2, 3] = False           # boundary dent
save('u_morph_in', mvol)
save('u_morph_closed', binary_closing(mvol, iterations=2))
save('u_morph_filled', binary_fill_holes(binary_closing(mvol, iterations=2)))

# robust combination (O'Brien 2014 background denoising, port of RobustCombination.m)
def robust_combination(uni, inv1, inv2, mf):
    uni = uni.astype(float); inv1 = inv1.astype(float); inv2 = inv2.astype(float)
    maxv = uni.max()
    integer = uni.min() >= 0 and maxv >= 0.51
    u = (uni - maxv / 2.0) / maxv if integer else uni
    inv1s = np.sign(u) * inv1
    with np.errstate(divide='ignore', invalid='ignore'):
        sq = np.sqrt(inv2 ** 2 - 4.0 * u ** 2 * inv2 ** 2)
        inv1pos = (-inv2 + sq) / (-2.0 * u)
        inv1neg = (-inv2 - sq) / (-2.0 * u)
    dpos = np.abs(inv1s - inv1pos); dneg = np.abs(inv1s - inv1neg)
    inv1final = inv1s.copy()
    inv1final = np.where(dpos > dneg, inv1neg, inv1final)
    inv1final = np.where(dpos <= dneg, inv1pos, inv1final)
    corner = inv2[:, -11:, -11:].mean()
    noise = mf * corner if corner != 0 else mf
    beta = noise ** 2
    robust = (inv1final * inv2 - beta) / (inv1final ** 2 + inv2 ** 2 + 2.0 * beta)
    return np.round(4095.0 * (robust + 0.5)) if integer else robust

rcs = (14, 12, 11)
rng2 = np.random.default_rng(1)
rc_inv1 = np.abs(rng2.normal(300, 80, rcs)) + 40.0
rc_inv2 = np.abs(rng2.normal(650, 130, rcs)) + 40.0
rc_sign = rng2.choice([-1.0, 1.0], rcs)
rc_int = ((rc_sign * rc_inv1) * rc_inv2) / ((rc_sign * rc_inv1) ** 2 + rc_inv2 ** 2)
rc_uni = np.round(4095.0 * (rc_int + 0.5))
save('u_rc_inv1', rc_inv1)
save('u_rc_inv2', rc_inv2)
save('u_rc_uni', rc_uni)
save('u_rc_out', robust_combination(rc_uni, rc_inv1, rc_inv2, 6.0))


# ===========================================================================
# 2. Phantom volumes (world-space analytic T1/B1 fields on two grids)
# ===========================================================================
print("[2] phantom + volume checkpoints")

MP_SHAPE = (24, 20, 18)
SA_SHAPE = (9, 8, 7)
# MP2RAGE grid 2 mm iso; SA2RAGE grid 5 mm, shifted (non-trivial resample).
# All values are exactly representable in float32 so the affine round-trips
# losslessly through the NIfTI header (srow is f32) for the CLI parity test.
MP_AFF = np.array([[2.0, 0, 0, -24.0], [0, 2.0, 0, -20.0], [0, 0, 2.0, -16.0], [0, 0, 0, 1]])
SA_AFF = np.array([[5.0, 0, 0, -22.0], [0, 5.0, 0, -18.0], [0, 0, 5.0, -15.0], [0, 0, 0, 1]])


def world_coords(shape, aff):
    ii, jj, kk = np.meshgrid(np.arange(shape[0]), np.arange(shape[1]),
                             np.arange(shape[2]), indexing='ij')
    x = aff[0, 0]*ii + aff[0, 1]*jj + aff[0, 2]*kk + aff[0, 3]
    y = aff[1, 0]*ii + aff[1, 1]*jj + aff[1, 2]*kk + aff[1, 3]
    z = aff[2, 0]*ii + aff[2, 1]*jj + aff[2, 2]*kk + aff[2, 3]
    return x, y, z


def fields(x, y, z):
    """Analytic ground-truth T1(s), B1(rel), brain mask in world space."""
    r = np.sqrt((x/22.0)**2 + (y/18.0)**2 + (z/16.0)**2)   # ellipsoid, ~1 at edge
    brain = r < 0.95
    # two tissue-ish shells for T1 + a smooth B1 that is centre-high
    t1 = 1.05 + 0.95 * np.clip(r, 0, 1) + 0.15 * np.cos(x/9.0)
    t1 = np.where(brain, t1, 4.0)
    b1 = 1.12 - 0.42 * np.clip(r, 0, 1) + 0.04 * np.sin(y/7.0)
    return t1, b1, brain


xm, ym, zm = world_coords(MP_SHAPE, MP_AFF)
T1_true, B1_true_mp, brain_mp = fields(xm, ym, zm)

# synthesize UNI (0..4095) from the forward model at (T1_true, B1_true).
# mprage_signal takes a length-2 flip pair indexed on axis 0, so B1 (which varies
# per voxel) is applied by looping over the small phantom.
mp_flip = np.asarray(MP['FlipDegrees'])
uni_intensity = np.zeros(MP_SHAPE)
for idx in np.ndindex(MP_SHAPE):
    s1, s2 = M.mprage_signal(MP['TR'], MP['TIs'], MP['NZslices'], MP['TRFLASH'],
                             B1_true_mp[idx] * mp_flip, T1_true[idx], INV_EFF)
    uni_intensity[idx] = (s1 * s2) / (s1**2 + s2**2)
uni = np.round(4095.0 * (uni_intensity + 0.5))
# INV2 magnitude for masking: bright inside brain, ~0 outside
inv2 = np.where(brain_mp, 600.0 + 120.0 * np.cos(zm/8.0), 5.0)
save('v_uni', uni)
save('v_inv2', inv2)

# SA2RAGE two-volume image on the coarse grid (loop for per-voxel B1)
xs, ys, zs = world_coords(SA_SHAPE, SA_AFF)
_, B1_true_sa, _ = fields(xs, ys, zs)
sa_flip = np.asarray(SA['FlipDegrees'])
Sa1 = np.zeros(SA_SHAPE)
Sa2 = np.zeros(SA_SHAPE)
for idx in np.ndindex(SA_SHAPE):
    b1 = B1_true_sa[idx]
    se = -np.cos(b1 * np.pi / 2.0)
    s1, s2 = M.mprage_signal(SA['TR'], SA['TIs'], SA['NZslices'], SA['TRFLASH'],
                             b1 * sa_flip, SA['averageT1'], inversion_efficiency=se)
    Sa1[idx], Sa2[idx] = s1, s2
sa_vol = np.stack([1000.0 * Sa1, 1000.0 * Sa2], axis=-1)
save('v_sa2rage', sa_vol)

# a synthetic Siemens-tfl-style B1 map (FLIP ANGLE MAP: achieved flip x10, prep 80 deg)
b1map_tfl = np.where(np.isfinite(B1_true_sa), 10.0 * 80.0 * B1_true_sa, 0.0)
save('v_b1map_tfl', b1map_tfl)

# ---- uncorrected T1 (seconds) ----
uncorr = M.t1_from_uni(uni, MP['TR'], MP['TIs'], MP['FlipDegrees'],
                       MP['NZslices'], MP['TRFLASH'], INV_EFF)
save('v_uncorr_T1_s', uncorr)

# ---- brain mask ----
mask = P.brain_mask(inv2)
save('v_mask', mask)

# ---- SA2RAGE ratio -> relative B1 (lowres), pre/post gaussian, then resampled ----
B1v, Iv = M.sa2rage_lookuptable(SA['TR'], SA['TIs'], SA['FlipDegrees'],
                                SA['NZslices'], SA['TRFLASH'], SA['averageT1'])
order = np.argsort(Iv)
Iv_s, B1v_s = Iv[order], B1v[order]
S_a, S_b = sa_vol[..., 0], sa_vol[..., 1]
with np.errstate(divide='ignore', invalid='ignore'):
    ratio_low = S_a / S_b
b1_low = np.interp(ratio_low, Iv_s, B1v_s, left=np.nan, right=np.nan)
sa_mask = S_b > 0.15 * np.percentile(S_b[S_b > 0], 99)
# mirror pipeline.py exactly: f64 gaussian, cast to f32 only at the resample input
b1_low_f = np.where(np.isfinite(b1_low), b1_low, np.nanmedian(b1_low[sa_mask]))   # f64
b1_low_f = gaussian_filter(b1_low_f, 1.0)                                          # f64 gaussian
save('v_b1_lowres_post_gauss', b1_low_f.astype(np.float32))                        # resample input
uni_img = nib.Nifti1Image(uni.astype(np.float32), MP_AFF)
B1_sa_mp = P.resample_to(nib.Nifti1Image(b1_low_f.astype(np.float32), SA_AFF), uni_img, order=1)
save('v_b1_resampled_mp', B1_sa_mp)

ratio_f = np.where(np.isfinite(ratio_low), ratio_low, np.nanmedian(ratio_low[sa_mask]))  # f64
ratio_f = gaussian_filter(ratio_f, 1.0)                                                   # f64 gaussian
ratio_mp = P.resample_to(nib.Nifti1Image(ratio_f.astype(np.float32), SA_AFF), uni_img, order=1)
ratio_mp[~mask] = 0
save('v_ratio_resampled_mp', ratio_mp)

# ---- B1-corrected T1 (iterative SA2RAGE) ----
res = M.t1b1_correct(uni, ratio_mp, MP, SA, brain=mask.astype(float),
                     inversion_efficiency=INV_EFF, n_iter=3)
save('v_corr_T1_ms', res['T1'])
save('v_corr_B1', res['B1'])
save('v_corr_UNI', res['MP2RAGEcorr'])

# ---- B1-corrected T1 (direct B1 map path) ----
rel = P._b1_to_relative(b1map_tfl, 'tfl', 80.0)
finite = np.isfinite(rel)
rel_f = gaussian_filter(np.where(finite, rel, np.nanmedian(rel[finite])).astype(np.float32), 1.0)
b1grid = P.resample_to(nib.Nifti1Image(rel_f, SA_AFF), uni_img, order=1)
save('v_b1map_grid_mp', b1grid)
resb = M.t1b1_correct_with_b1map(uni, np.nan_to_num(b1grid, nan=0.0), MP,
                                 brain=mask.astype(float), inversion_efficiency=INV_EFF)
save('v_b1map_corr_T1_ms', resb['T1'])
save('v_b1map_corr_UNI', resb['MP2RAGEcorr'])


# ===========================================================================
# 3. Phantom NIfTIs (for the native CLI parity test, M2)
# ===========================================================================
print("[3] phantom NIfTIs")
def write_nii(arr, aff, name, dtype=np.float64):
    # float64 + f32-exact affine -> the Rust CLI reads back exactly the arrays
    # the golden checkpoints were computed from.
    img = nib.Nifti1Image(np.asarray(arr, dtype=dtype), aff)
    nib.save(img, os.path.join(PHA, name))
    print(f"  phantom/{name}")

write_nii(uni, MP_AFF, 'phantom_UNI.nii.gz')
write_nii(inv2, MP_AFF, 'phantom_INV2.nii.gz')
write_nii(sa_vol, SA_AFF, 'phantom_SA2RAGE.nii.gz')
write_nii(b1map_tfl, SA_AFF, 'phantom_B1map_tfl.nii.gz')


# ===========================================================================
with open(os.path.join(OUT, 'manifest.json'), 'w') as f:
    json.dump(MANIFEST, f, indent=2)
print(f"\nwrote {len(MANIFEST['checkpoints'])} checkpoints to tools/golden/ + manifest.json")
