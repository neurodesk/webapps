"""UNI background denoising and B1-map FOV extension.

Two small, optional preprocessing kernels that bring the Python package to
parity with the Rust/WASM core:

  * robust_combination  -> O'Brien (2014) robust UNI/background denoising, a
                           faithful port of RobustCombination.m. Removes the
                           salt-and-pepper background of the MP2RAGE UNI image
                           by regularising the two-inversion combination with a
                           noise term estimated from an INV2 corner slab.
  * extend_b1_fov       -> smooth low-order polynomial extrapolation of a
                           (relative) B1+ transmit field into brain voxels that
                           fell outside the measured B1-map field-of-view. Port
                           of crates/mp2rage-core/src/b1fill.rs.

References
----------
O'Brien et al., PLoS ONE 9:e99676 (2014)  -- robust background removal for UNI
"""
from __future__ import annotations
import numpy as np


# ============================================================================
# 1. Robust UNI combination  (port of RobustCombination.m, O'Brien 2014)
# ============================================================================
def robust_combination(uni, inv1, inv2, mf=6.0):
    """Denoise the MP2RAGE UNI image using the two inversion magnitudes.

    The UNI image is the noise-sensitive combination (INV1*INV2)/(INV1^2+INV2^2)
    of the two magnitude inversion images. O'Brien's robust combination adds a
    regularisation term beta to numerator and denominator so that low-signal
    background voxels collapse to the mid-grey level instead of random noise:

        robust = (INV1*INV2 - beta) / (INV1^2 + INV2^2 + 2*beta)

    beta is (mf * <INV2 corner>)^2, i.e. a multiple of the background noise
    estimated from an 11-voxel corner slab of INV2. Because Siemens stores the
    magnitude INV1/INV2 without sign, the correct sign of INV1 is recovered from
    the UNI value via the quadratic that links the (signed) INV1 to INV2 and the
    scaled UNI, then the root closer to the measured |INV1| is kept.

    Parameters
    ----------
    uni, inv1, inv2 : ndarray
        The MP2RAGE UNI image and the two inversion magnitude images, same shape.
    mf : float
        Regularisation / noise multiplication factor (O'Brien's default 6).

    Returns
    -------
    ndarray
        The denoised UNI. If UNI came in as a rescaled 0..4095 integer-valued
        image the output is rescaled back to 0..4095 (round half to even);
        otherwise the raw -0.5..0.5 combination is returned.
    """
    uni = uni.astype(float)
    inv1 = inv1.astype(float)
    inv2 = inv2.astype(float)

    # detect the 0..4095 Siemens-scaled UNI and map it to the model's -0.5..0.5
    maxv = uni.max()
    integer = uni.min() >= 0 and maxv >= 0.51
    u = (uni - maxv / 2.0) / maxv if integer else uni

    # sign-correct |INV1| using the sign of the (scaled) UNI, then pick the root
    # of the UNI quadratic that is closest to the measured magnitude
    inv1s = np.sign(u) * inv1
    with np.errstate(divide='ignore', invalid='ignore'):
        sq = np.sqrt(inv2 ** 2 - 4.0 * u ** 2 * inv2 ** 2)
        inv1pos = (-inv2 + sq) / (-2.0 * u)
        inv1neg = (-inv2 - sq) / (-2.0 * u)
    dpos = np.abs(inv1s - inv1pos)
    dneg = np.abs(inv1s - inv1neg)
    inv1final = inv1s.copy()
    inv1final = np.where(dpos > dneg, inv1neg, inv1final)
    inv1final = np.where(dpos <= dneg, inv1pos, inv1final)

    # noise floor from an 11-voxel corner slab of INV2 -> regularisation beta
    corner = inv2[:, -11:, -11:].mean()
    noise = mf * corner if corner != 0 else mf
    beta = noise ** 2

    robust = (inv1final * inv2 - beta) / (inv1final ** 2 + inv2 ** 2 + 2.0 * beta)
    return np.round(4095.0 * (robust + 0.5)) if integer else robust


# ============================================================================
# 2. B1 FOV extension  (port of crates/mp2rage-core/src/b1fill.rs)
# ============================================================================
def _monomial_exponents(deg):
    """Exponent triples (a, b, c) with a+b+c <= deg, in the b1fill.rs order."""
    exps = []
    for total in range(deg + 1):
        for a in range(total + 1):
            for b in range(total - a + 1):
                exps.append((a, b, total - a - b))
    return exps


def extend_b1_fov(field, mask, deg=3, clamp=(0.35, 1.7)):
    """Fill non-finite in-mask B1 voxels with a smooth low-order polynomial.

    The B1+ transmit field is spatially smooth (low spatial frequency only), so
    a degree-3 3-D polynomial fitted to the *measured* in-brain voxels is a
    physically reasonable model for the missing ones. Voxels that were measured
    (finite) and voxels outside the mask are returned unchanged; only in-mask
    non-finite voxels are filled, and the fill is clamped to a plausible
    relative-B1 range so the polynomial cannot blow up far from the data.

    Falls back to a constant (median of the usable voxels) if there are too few
    measured voxels to fit the polynomial robustly.

    Parameters
    ----------
    field : ndarray (3-D)
        Relative B1 on the target grid, with non-finite (NaN) outside the
        measured B1 FOV.
    mask : ndarray (3-D bool)
        Brain mask; only voxels inside it are ever filled.
    deg : int
        Polynomial total degree (Rust default 3).
    clamp : (float, float)
        (lo, hi) plausible relative-B1 range for both the fit set and the fill.

    Returns
    -------
    ndarray
        A copy of `field` with the missing in-mask voxels filled.
    """
    field = np.asarray(field, dtype=float)
    mask = np.asarray(mask, dtype=bool)
    lo, hi = clamp
    nx, ny, nz = field.shape
    out = field.copy()

    # in-mask voxels needing a fill (non-finite = outside the measured B1 FOV)
    missing = mask & ~np.isfinite(field)
    if not missing.any():
        return out

    # normalise voxel coords to [-1, 1] for conditioning (matches b1fill.rs)
    def _scale(n):
        return 2.0 / (n - 1.0) if n > 1 else 0.0
    sx, sy, sz = _scale(nx), _scale(ny), _scale(nz)
    ii, jj, kk = np.meshgrid(np.arange(nx), np.arange(ny), np.arange(nz), indexing='ij')
    xn = ii * sx - 1.0
    yn = jj * sy - 1.0
    zn = kk * sz - 1.0

    # fit set: inside mask, finite, plausible value
    fit = mask & np.isfinite(field) & (field >= lo) & (field <= hi)
    fit_vals = field[fit]

    exps = _monomial_exponents(deg)
    p = len(exps)

    # need clearly more equations than unknowns for a stable fit -> else median
    if fit_vals.size < 4 * p:
        if fit_vals.size:
            out[missing] = np.clip(np.median(fit_vals), lo, hi)
        return out

    def _design(x, y, z):
        # monomial design matrix, one column x^a y^b z^c per exponent triple
        cols = [(x ** a) * (y ** b) * (z ** c) for (a, b, c) in exps]
        return np.stack(cols, axis=-1)

    # weighted least squares over the monomial basis (SVD-based, rank-safe)
    A = _design(xn[fit], yn[fit], zn[fit])
    coef, *_ = np.linalg.lstsq(A, fit_vals, rcond=None)

    B = _design(xn[missing], yn[missing], zn[missing])
    out[missing] = np.clip(B @ coef, lo, hi)
    return out
