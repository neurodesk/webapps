#!/usr/bin/env python3
"""
mp2rage_t1.py
=============
A self-contained Python port of the T1-mapping parts of José P. Marques'
MP2RAGE-related-scripts (https://github.com/JosePMarques/MP2RAGE-related-scripts).

Implements, faithfully to the original MATLAB:

  * MPRAGEfunc                    -> Bloch steady-state signal of the two GRE readouts
  * MP2RAGE_lookuptable           -> UNI intensity vs T1 lookup (monotonic branch)
  * T1estimateMP2RAGE             -> uncorrected T1 from the UNI image
  * B1mappingSa2RAGElookuptable   -> SA2RAGE ratio vs B1 lookup
  * T1B1correctpackage            -> iterative B1-corrected T1 (SA2RAGE B1 source)

Only the 'normal' (non water-excitation) branch is ported, which is what the
Siemens MP2RAGE / SA2RAGE magnitude reconstruction uses.

References
----------
Marques et al., NeuroImage 49:1271-1281 (2010)  -- MP2RAGE T1 mapping
Marques & Gruetter, PLoS ONE 8:e69294 (2013)     -- B1 correction / SA2RAGE
Eggenschwiler et al., MRM 67:1609-1619 (2012)    -- SA2RAGE B1 mapping

Author: refactor generated for T. Shaw (UQ), 2026.
"""

from __future__ import annotations
import numpy as np


# ============================================================================
# 1. Core Bloch model  (port of func/MPRAGEfunc.m, 'normal' branch, nimages=2)
# ============================================================================
def mprage_signal(mp2rage_tr, inversiontimes, nZslices, flash_tr,
                  flip_deg, T1s, inversion_efficiency=0.96):
    """Steady-state MP2RAGE signal of the two GRE readout blocks.

    Parameters mirror MPRAGEfunc.m exactly.

    mp2rage_tr : outer TR between successive inversion pulses [s]
    inversiontimes : (TI1, TI2) to the k-space centre of each readout [s]
    nZslices : scalar or (n_before_centre, n_after_centre) excitations per block
    flash_tr : GRE readout TR (echo spacing) [s]
    flip_deg : (alpha1, alpha2) readout flip angles [degrees]
    T1s : scalar or ndarray of T1 values [s]
    inversion_efficiency : adiabatic inversion efficiency (Siemens ~0.96)

    Returns (S1, S2) with the same shape as T1s.
    """
    T1s = np.asarray(T1s, dtype=float)
    fa = np.deg2rad(np.asarray(flip_deg, dtype=float))
    a1, a2 = fa[0], fa[1]

    if np.ndim(nZslices) == 0:
        nZ_bef = nZslices / 2.0
        nZ_aft = nZslices / 2.0
        nZtot = float(nZslices)
    else:
        nZ_bef, nZ_aft = float(nZslices[0]), float(nZslices[1])
        nZtot = nZ_bef + nZ_aft

    M0 = 1.0
    inv_eff = inversion_efficiency

    with np.errstate(over='ignore', divide='ignore', invalid='ignore'):
        E1 = np.exp(-flash_tr / T1s)

        TA_bef = nZ_bef * flash_tr
        TA_aft = nZ_aft * flash_tr
        TA = nZtot * flash_tr

        # recovery gaps TD(1), TD(2), TD(3)  (MATLAB 1-indexed)
        TD1 = inversiontimes[0] - TA_bef
        TD2 = inversiontimes[1] - inversiontimes[0] - TA
        TD3 = mp2rage_tr - inversiontimes[1] - TA_aft
        E_TD1 = np.exp(-TD1 / T1s)
        E_TD2 = np.exp(-TD2 / T1s)
        E_TD3 = np.exp(-TD3 / T1s)

        # cos(alpha)*E1 per readout ; sin(alpha) per readout
        c1 = np.cos(a1) * E1
        c2 = np.cos(a2) * E1
        s1 = np.sin(a1)
        s2 = np.sin(a2)

        # ---- steady-state longitudinal magnetisation --------------------
        denom = 1.0 + inv_eff * ((c1 * c2) ** nZtot) * (E_TD1 * E_TD2 * E_TD3)

        num = M0 * (1.0 - E_TD1)
        # readout 1
        num = num * (c1 ** nZtot) + M0 * (1.0 - E1) * (1.0 - c1 ** nZtot) / (1.0 - c1)
        num = num * E_TD2 + M0 * (1.0 - E_TD2)
        # readout 2
        num = num * (c2 ** nZtot) + M0 * (1.0 - E1) * (1.0 - c2 ** nZtot) / (1.0 - c2)
        num = num * E_TD3 + M0 * (1.0 - E_TD3)

        MZss = num / denom

        # ---- signal at k-space centre of each readout -------------------
        temp = (-inv_eff * MZss * E_TD1 + M0 * (1.0 - E_TD1)) * (c1 ** nZ_bef) \
            + M0 * (1.0 - E1) * (1.0 - c1 ** nZ_bef) / (1.0 - c1)
        S1 = s1 * temp

        temp = temp * (c1 ** nZ_aft) + M0 * (1.0 - E1) * (1.0 - c1 ** nZ_aft) / (1.0 - c1)
        temp = (temp * E_TD2 + M0 * (1.0 - E_TD2)) * (c2 ** nZ_bef) \
            + M0 * (1.0 - E1) * (1.0 - c2 ** nZ_bef) / (1.0 - c2)
        S2 = s2 * temp

    return S1, S2


def _timing_valid(mp2rage_tr, TIs, nZslices, flash_tr):
    if np.ndim(nZslices) == 0:
        nZ_bef = nZslices / 2.0
        nZ_aft = nZslices / 2.0
        nZtot = float(nZslices)
    else:
        nZ_bef, nZ_aft = float(nZslices[0]), float(nZslices[1])
        nZtot = nZ_bef + nZ_aft
    return ((TIs[1] - TIs[0]) >= nZtot * flash_tr
            and TIs[0] >= nZ_bef * flash_tr
            and TIs[1] <= (mp2rage_tr - nZ_aft * flash_tr))


# ============================================================================
# 2. MP2RAGE UNI lookup table  (port of func/MP2RAGE_lookuptable.m)
# ============================================================================
def mp2rage_lookuptable(mp2rage_tr, TIs, flip_deg, nZslices, flash_tr,
                        inversion_efficiency=0.96, all_data=False):
    """Return (intensity, T1vector) of the MP2RAGE UNI combination vs T1.

    intensity = Re(S1 conj(S2)) / (|S1|^2 + |S2|^2) ranges over [-0.5, 0.5].
    By default only the monotonic branch is returned (endpoints padded to
    +0.5 / -0.5) so it can be used directly for interpolation.
    """
    T1vector = np.arange(0.05, 5.0 + 1e-9, 0.05)

    if not _timing_valid(mp2rage_tr, TIs, nZslices, flash_tr):
        raise ValueError(
            "MP2RAGE timing invalid for these parameters (readout blocks do "
            "not fit the inversion times). Check TRFLASH / NZslices / TIs.")

    S1, S2 = mprage_signal(mp2rage_tr, TIs, nZslices, flash_tr, flip_deg,
                           T1vector, inversion_efficiency)
    intensity = (S1 * S2) / (S1 ** 2 + S2 ** 2)   # signals are real here

    if all_data:
        return intensity, T1vector

    minindex = int(np.argmax(intensity))
    maxindex = int(np.argmin(intensity))
    I = intensity[minindex:maxindex + 1].copy()
    T = T1vector[minindex:maxindex + 1].copy()
    I[0] = 0.5
    I[-1] = -0.5
    return I, T


def _interp_decreasing(x_dec, y, query):
    """np.interp for a monotonically *decreasing* x (returns NaN outside)."""
    xi = x_dec[::-1]
    yi = y[::-1]
    return np.interp(query, xi, yi, left=np.nan, right=np.nan)


def t1_from_uni(uni_img, mp2rage_tr, TIs, flip_deg, nZslices, flash_tr,
                inversion_efficiency=0.96):
    """Uncorrected T1 [s] from a UNI image (port of T1estimateMP2RAGE.m).

    Matches the MATLAB scaling rule: if the data are not already in
    [-0.5, 0.5] they are assumed to be a 0..4095 DICOM UNI and rescaled.
    """
    I, T = mp2rage_lookuptable(mp2rage_tr, TIs, flip_deg, nZslices, flash_tr,
                               inversion_efficiency)
    uni = np.asarray(uni_img, dtype=float)
    if np.nanmax(np.abs(uni)) > 1.0:
        uni_scaled = -0.5 + uni / 4095.0
    else:
        uni_scaled = uni
    T1 = _interp_decreasing(I, T, uni_scaled.ravel())
    T1[np.isnan(T1)] = 0.0
    return T1.reshape(uni.shape)


# ============================================================================
# 3. SA2RAGE B1 lookup table  (port of func/B1mappingSa2RAGElookuptable.m)
# ============================================================================
def sa2rage_lookuptable(mp2rage_tr, TIs, flip_deg, nZslices, flash_tr,
                        T1average=1.5):
    """Return (B1vector, intensity) of the SA2RAGE ratio (S1/S2) vs relative B1.

    The saturation-pulse efficiency is modelled as -cos(B1*pi/2), exactly as
    in the original (passed as the inversion_efficiency argument).
    """
    B1vector = np.arange(0.005, 2.5 + 1e-9, 0.005)
    intensity = np.zeros_like(B1vector)

    if np.ndim(nZslices) == 0:
        nZ_bef = nZslices / 2.0
        nZ_aft = nZslices / 2.0
        nZtot = float(nZslices)
    else:
        nZ_bef, nZ_aft = float(nZslices[0]), float(nZslices[1])
        nZtot = nZ_bef + nZ_aft

    valid = ((TIs[1] - TIs[0]) >= nZtot * flash_tr
             and TIs[0] >= nZ_bef * flash_tr
             and TIs[1] <= (mp2rage_tr - nZ_aft * flash_tr))
    if not valid:
        raise ValueError("SA2RAGE timing invalid for these parameters.")

    for m, B1 in enumerate(B1vector):
        sat_eff = -np.cos(B1 * np.pi / 2.0)
        S1, S2 = mprage_signal(mp2rage_tr, TIs, nZslices, flash_tr,
                               B1 * np.asarray(flip_deg), T1average,
                               inversion_efficiency=sat_eff)
        intensity[m] = np.real(S1) / np.real(S2)
    return B1vector, intensity


# ============================================================================
# 4. Iterative B1-corrected T1  (port of func/T1B1correctpackage.m)
# ============================================================================
from scipy.interpolate import PchipInterpolator
from scipy.interpolate import RegularGridInterpolator


def _pchip_safe(x, y, xq):
    """PchipInterpolator with sorting/dedup/NaN handling; NaN outside range."""
    x = np.asarray(x, float)
    y = np.asarray(y, float)
    good = np.isfinite(x) & np.isfinite(y)
    x, y = x[good], y[good]
    if x.size < 2:
        return np.full_like(np.asarray(xq, float), np.nan)
    order = np.argsort(x)
    x, y = x[order], y[order]
    ux, idx = np.unique(x, return_index=True)
    uy = y[idx]
    if ux.size < 2:
        return np.full_like(np.asarray(xq, float), np.nan)
    f = PchipInterpolator(ux, uy, extrapolate=False)
    return f(xq)


def _build_mp2rage_t1_lookup(mp2rage, invEFF):
    """Interpolator T1(B1, UNI) shared by both B1-correction routines.

    Builds the MP2RAGE UNI intensity over a (relative-B1, T1) grid and inverts
    it, returning (B1_vector, MP2RAGE_vector, fT1) where fT1 maps
    (relative B1, UNI in [-0.5, 0.5]) -> T1 [s]  (NaN outside the grid range).
    """
    B1_vector = np.arange(0.005, 1.9 + 1e-9, 0.05)
    T1_vector = np.arange(0.5, 5.2 + 1e-9, 0.05)

    MP2RAGEmatrix = np.full((B1_vector.size, T1_vector.size), np.nan)
    for k, b1val in enumerate(B1_vector):
        I, T = mp2rage_lookuptable(mp2rage['TR'], mp2rage['TIs'],
                                   b1val * np.asarray(mp2rage['FlipDegrees']),
                                   mp2rage['NZslices'], mp2rage['TRFLASH'],
                                   invEFF)
        MP2RAGEmatrix[k, :] = np.interp(T1_vector, T, I, left=np.nan, right=np.nan)

    MP2RAGE_vector = np.linspace(-0.5, 0.5, 100)
    T1matrix = np.zeros((B1_vector.size, MP2RAGE_vector.size))
    for k in range(B1_vector.size):
        T1matrix[k, :] = _pchip_safe(MP2RAGEmatrix[k, :], T1_vector, MP2RAGE_vector)
    T1matrix = np.nan_to_num(T1matrix, nan=4.0)

    fT1 = RegularGridInterpolator((B1_vector, MP2RAGE_vector), T1matrix,
                                  bounds_error=False, fill_value=np.nan)
    return B1_vector, MP2RAGE_vector, fT1


def t1b1_correct(uni_img, sa2rage_ratio, mp2rage, sa2rage, brain=None,
                 inversion_efficiency=0.96, n_iter=3):
    """B1-corrected T1 from a UNI image and a SA2RAGE ratio image.

    uni_img       : MP2RAGE UNI (0..4095 DICOM), MP2RAGE grid
    sa2rage_ratio : SA2RAGE S1/S2 ratio, already resampled to the MP2RAGE grid
    mp2rage, sa2rage : dicts with keys TR, TRFLASH, TIs, NZslices, FlipDegrees
                       (sa2rage additionally averageT1)
    brain         : optional mask (nonzero where to compute)

    Returns dict with 'T1' [ms], 'B1' [relative, 1.0=nominal] and
    'MP2RAGEcorr' (0..4095).
    """
    uni = np.asarray(uni_img, dtype=float)
    ratio = np.asarray(sa2rage_ratio, dtype=float)
    shape = uni.shape

    if brain is None:
        brain = np.ones(shape, dtype=float)
    brain = np.asarray(brain, dtype=float).copy()

    invEFF = inversion_efficiency

    # ---- measured images in model units ---------------------------------
    MP2RAGEimg = uni / 4095.0 - 0.5
    Sa2RAGEimg = ratio.copy()          # our data are the raw S1/S2 ratio

    # ---- T1(B1, UNI) lookup (shared with the B1-map corrector) ----------
    B1_vector, MP2RAGE_vector, fT1 = _build_mp2rage_t1_lookup(mp2rage, invEFF)
    T1_vector = np.arange(0.5, 5.2 + 1e-9, 0.05)

    # ---- build SA2RAGE ratio as f(T1, B1), then invert to B1(T1, ratio) -
    Sa2RAGEmatrix = np.full((T1_vector.size, B1_vector.size), np.nan)
    for k, t1val in enumerate(T1_vector):
        B1v, I = sa2rage_lookuptable(sa2rage['TR'], sa2rage['TIs'],
                                     sa2rage['FlipDegrees'], sa2rage['NZslices'],
                                     sa2rage['TRFLASH'], T1average=t1val)
        Sa2RAGEmatrix[k, :] = np.interp(B1_vector, B1v, I, left=np.nan, right=np.nan)

    npoints = 100
    Sa2RAGE_vector = np.linspace(np.nanmin(Sa2RAGEmatrix),
                                 np.nanmax(Sa2RAGEmatrix), npoints)
    B1matrix = np.zeros((T1_vector.size, npoints))
    for k in range(T1_vector.size):
        B1matrix[k, :] = _pchip_safe(Sa2RAGEmatrix[k, :], B1_vector, Sa2RAGE_vector)
    B1matrix = np.nan_to_num(B1matrix, nan=2.0)

    fB1 = RegularGridInterpolator((T1_vector, Sa2RAGE_vector), B1matrix,
                                  bounds_error=False, fill_value=np.nan)

    # ---- iterative correction ------------------------------------------
    T1temp = np.zeros(shape)
    B1temp = np.zeros(shape)
    brain[ratio == 0] = 0
    brain[MP2RAGEimg == MP2RAGEimg.min()] = 0
    T1temp[brain == 0] = 0.0
    T1temp[brain != 0] = 1.5
    Sa2_filled = Sa2RAGEimg.copy()
    Sa2_filled[np.isnan(Sa2_filled)] = -0.5

    idx = brain != 0
    for _ in range(n_iter):
        b = fB1(np.column_stack([T1temp[idx], Sa2_filled[idx]]))
        b[np.isnan(b)] = 2.0
        B1temp[idx] = b
        t = fT1(np.column_stack([B1temp[idx], MP2RAGEimg[idx]]))
        t[np.isnan(t)] = 4.0
        T1temp[idx] = t

    # ---- corrected UNI and unit scaling --------------------------------
    I, T = mp2rage_lookuptable(mp2rage['TR'], mp2rage['TIs'],
                               mp2rage['FlipDegrees'], mp2rage['NZslices'],
                               mp2rage['TRFLASH'], invEFF)
    # forward map T1 -> UNI intensity (T ascending, I its intensity)
    MP2RAGEcorr = np.interp(T1temp.ravel(), T, I, left=np.nan, right=np.nan).reshape(shape)
    MP2RAGEcorr[np.isnan(MP2RAGEcorr)] = -0.5
    MP2RAGEcorr = np.round(4095.0 * (MP2RAGEcorr + 0.5))

    return {
        'T1': T1temp * 1000.0,     # ms
        'B1': B1temp,              # relative (1.0 = nominal)
        'MP2RAGEcorr': MP2RAGEcorr,
    }


# ============================================================================
# 5. B1-corrected T1 from a known B1 map  (port of func/T1B1correctpackageTFL.m)
# ============================================================================
def t1b1_correct_with_b1map(uni_img, b1_rel, mp2rage, brain=None,
                            inversion_efficiency=0.96):
    """B1-corrected T1 from a UNI image and a *measured* relative B1 map.

    Use this when B1 has been mapped directly by any method (e.g. a Siemens
    tfl B1 map at 3T) instead of derived from SA2RAGE. Because B1 is known,
    T1 is read straight from the T1(B1, UNI) lookup -- no iteration, no SA2RAGE.

    uni_img : MP2RAGE UNI (0..4095 DICOM), on the MP2RAGE grid
    b1_rel  : relative B1 (1.0 = nominal), already resampled to the MP2RAGE grid
    mp2rage : dict with keys TR, TRFLASH, TIs, NZslices, FlipDegrees
    brain   : optional mask (nonzero where to compute)

    Returns dict with 'T1' [ms], 'B1' [relative] and 'MP2RAGEcorr' (0..4095).
    """
    uni = np.asarray(uni_img, dtype=float)
    b1 = np.asarray(b1_rel, dtype=float)
    shape = uni.shape

    if brain is None:
        brain = np.ones(shape, dtype=float)
    brain = np.asarray(brain, dtype=float).copy()

    invEFF = inversion_efficiency
    MP2RAGEimg = uni / 4095.0 - 0.5

    B1_vector, _, fT1 = _build_mp2rage_t1_lookup(mp2rage, invEFF)

    # do not solve where B1 is missing or the UNI is at its floor
    brain[~np.isfinite(b1)] = 0
    brain[b1 == 0] = 0
    brain[MP2RAGEimg == MP2RAGEimg.min()] = 0

    T1temp = np.zeros(shape)
    idx = brain != 0
    t = fT1(np.column_stack([b1[idx], MP2RAGEimg[idx]]))
    t[np.isnan(t)] = 4.0           # long-T1/out-of-range voxels (e.g. CSF)
    T1temp[idx] = t

    # ---- corrected UNI and unit scaling --------------------------------
    I, T = mp2rage_lookuptable(mp2rage['TR'], mp2rage['TIs'],
                               mp2rage['FlipDegrees'], mp2rage['NZslices'],
                               mp2rage['TRFLASH'], invEFF)
    MP2RAGEcorr = np.interp(T1temp.ravel(), T, I, left=np.nan, right=np.nan).reshape(shape)
    MP2RAGEcorr[np.isnan(MP2RAGEcorr)] = -0.5
    MP2RAGEcorr = np.round(4095.0 * (MP2RAGEcorr + 0.5))

    return {
        'T1': T1temp * 1000.0,     # ms
        'B1': np.nan_to_num(b1),   # relative (1.0 = nominal)
        'MP2RAGEcorr': MP2RAGEcorr,
    }
