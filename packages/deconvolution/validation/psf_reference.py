"""Reference values for the Gibson-Lanni PSF (packages/deconvolution/test/psf.test.js).

Two independent references per case:

* psfmodels 0.3.3 ``scalar_psf`` (GPL-3.0, Aguet's C++ integrator; used here only as an
  external reference, nothing of it ships). With ``sf=1, mode=0`` it samples pixel centres and
  integrates exactly at integer pixel radii, so the central row (all z) holds its own integrals,
  free of its radial interpolation. Normalised to its volume maximum.
* scipy.integrate.quad (adaptive, split at the critical radii) on the Gibson-Lanni integral
  written out below from Gibson & Lanni (1991) and Aguet et al. (2009, eq. 5), at sample points,
  normalised to the on-axis maximum.

Run with the pinned requirements: python -I psf_reference.py > psf-reference.json
"""
import json
import sys
import warnings

import numpy as np
import psfmodels
import scipy
import scipy.integrate as si
import scipy.special as sp

warnings.filterwarnings("ignore")

NG = NG0 = 1.515
TG = TG0 = 170.0
TI0 = 150.0

CASES = [
    dict(id="oil-widefield", na=1.4, ni=1.515, ns=1.47, emission=0.52, excitation=0, dxy=0.065, dz=0.13, xy=31, nz=21, pz=0),
    dict(id="oil-mismatch-depth", na=1.4, ni=1.515, ns=1.33, emission=0.6, excitation=0, dxy=0.1, dz=0.2, xy=25, nz=31, pz=5),
    dict(id="air-0.95", na=0.95, ni=1.0, ns=1.33, emission=0.6, excitation=0, dxy=0.1075, dz=0.1, xy=25, nz=21, pz=0),
    dict(id="water-1.2-depth", na=1.2, ni=1.333, ns=1.333, emission=0.52, excitation=0, dxy=0.1, dz=0.25, xy=25, nz=21, pz=2),
    dict(id="confocal-example", na=1.4, ni=1.518, ns=1.47, emission=0.52526, excitation=0.488, dxy=0.0658941, dz=0.13, xy=43, nz=31, pz=0),
    dict(id="low-na", na=0.3, ni=1.0, ns=1.33, emission=0.52, excitation=0, dxy=0.3, dz=1.0, xy=21, nz=15, pz=0),
    # Oil into a sample of index 1.45, above the NA, 10 µm deep: index mismatch without evanescent light.
    dict(id="oil-mismatch-depth-1.45", na=1.4, ni=1.515, ns=1.45, emission=0.52, excitation=0, dxy=0.1, dz=0.2, xy=25, nz=31, pz=10),
]


def zv(c):
    lim = (c["nz"] - 1) * c["dz"] / 2
    return np.linspace(-lim + c["pz"], lim + c["pz"], c["nz"])


def psfmodels_volume(c, wavelength):
    params = dict(NA=c["na"], ni=c["ni"], ni0=c["ni"], ns=c["ns"], ng=NG, ng0=NG0, tg=TG, tg0=TG0, ti0=TI0, sf=1, mode=0)
    volume = psfmodels.scalar_psf(zv(c), c["xy"], c["dxy"], c["pz"], wavelength, params=params, normalize=False)
    return volume / volume.max()


def opd(c, rho, z):
    nr2 = c["na"] ** 2 * rho * rho
    s = lambda n: np.sqrt(complex(n * n - nr2))
    zp = c["pz"]
    ti = zp - z + c["ni"] * (TI0 / c["ni"] + TG0 / NG0 - TG / NG - zp / c["ns"])
    return zp * s(c["ns"]) + ti * s(c["ni"]) + TG * s(NG) - TG0 * s(NG0) - TI0 * s(c["ni"])


def quad_intensity(c, r, z, wavelength):
    k = 2 * np.pi / wavelength
    f = lambda rho: sp.j0(k * c["na"] * r * rho) * np.exp(1j * k * opd(c, rho, z)) * rho
    points = sorted(n / c["na"] for n in (c["ns"], c["ni"], NG) if n / c["na"] < 1) or None
    kw = dict(points=points, limit=5000, epsabs=1e-15, epsrel=1e-13)
    re = si.quad(lambda x: f(x).real, 0, 1, **kw)[0]
    im = si.quad(lambda x: f(x).imag, 0, 1, **kw)[0]
    return re * re + im * im


def main():
    out = {
        "generator": "packages/deconvolution/validation/psf_reference.py",
        "versions": {"psfmodels": psfmodels.__version__, "scipy": scipy.__version__, "numpy": np.__version__},
        "cases": [],
    }
    for c in CASES:
        z = zv(c)
        wavelengths = [c["emission"]] + ([c["excitation"]] if c["excitation"] else [])
        # psfmodels: central row of every plane, product over wavelengths for confocal.
        volume = np.ones((c["nz"], c["xy"], c["xy"]))
        for w in wavelengths:
            volume *= psfmodels_volume(c, w)
        volume /= volume.max()
        centre = c["xy"] // 2
        row = volume[:, centre, :]
        # Quadrature: on-axis values for every plane (to find the peak) and off-axis samples.
        samples = [(zi, dx) for zi in range(0, c["nz"], max(1, c["nz"] // 6)) for dx in (0, 1, 3, 6) if dx <= centre]
        peaks = {w: max(quad_intensity(c, 0.0, zt, w) for zt in z) for w in wavelengths}

        def product(r, zz):
            value = 1.0
            for w in wavelengths:
                value *= quad_intensity(c, r, zz, w) / peaks[w]
            return value

        axis = [product(0.0, zz) for zz in z]
        peak = max(axis)
        quad = [[zi, dx, product(dx * c["dxy"], z[zi]) / peak] for zi, dx in samples]
        evanescent = any(n < c["na"] for n in (c["ns"], c["ni"], NG))
        out["cases"].append({**c, "evanescent": evanescent, "psfmodelsCentralRow": [[float(f"{v:.12g}") for v in line] for line in row], "quadrature": quad})
        print(c["id"], file=sys.stderr)
    json.dump(out, sys.stdout, separators=(",", ":"))
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
