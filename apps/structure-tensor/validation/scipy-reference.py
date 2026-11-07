"""Independent reference for src/tensor.js, written on scipy.ndimage and numpy.linalg.

It rebuilds the synthetic images of test/synthetic.mjs, reads the example TIFF, and computes
the same structure tensor with scipy.ndimage.gaussian_filter (derivative order 1 at sigma,
window at rho, mode 'reflect', truncate 4) and numpy.linalg.eigh, then writes the values the
tests compare with to validation/reference.json.

    python3 -I validation/scipy-reference.py <example.tif> validation/reference.json
"""
import hashlib
import json
import sys

import numpy as np
import scipy
import tifffile
from scipy import ndimage

SETTINGS = {"sigma": 1.0, "rho": 3.0, "minCoherency": 0.2, "minEnergy": 0.01}


def tensor(image, sigma, rho, spacing=(1.0, 1.0, 1.0)):
    """Image indexed [z, y, x] (or [y, x]); returns the components in tensor.js order."""
    nd = image.ndim
    # Axes of the array are (z,) y, x; scales are given in pixels of x.
    dx = spacing[0]
    axis_spacing = [spacing[2], spacing[1], spacing[0]][-nd:]
    sig = [sigma * dx / s for s in axis_spacing]
    win = [rho * dx / s for s in axis_spacing]
    grads = {}
    names = "zyx"[-nd:]
    for axis, name in enumerate(names):
        order = [0] * nd
        order[axis] = 1
        grads[name] = ndimage.gaussian_filter(image, sig, order=order, mode="reflect", truncate=4.0) * (dx / axis_spacing[axis])
    pairs = ["xx", "xy", "yy"] if nd == 2 else ["xx", "xy", "xz", "yy", "yz", "zz"]
    return [ndimage.gaussian_filter(grads[a] * grads[b], win, mode="reflect", truncate=4.0) for a, b in pairs]


def maps2d(jxx, jxy, jyy):
    orientation = 0.5 * np.degrees(np.arctan2(2 * jxy, jyy - jxx))
    orientation = np.where(orientation <= -90, orientation + 180, orientation)
    trace = jxx + jyy
    with np.errstate(invalid="ignore", divide="ignore"):
        coherency = np.where(trace > 0, np.minimum(1, np.hypot(jyy - jxx, 2 * jxy) / trace), 0)
    return orientation, coherency, trace


def fibre_vector(components):
    jxx, jxy, jxz, jyy, jyz, jzz = components
    matrix = np.array([[jxx, jxy, jxz], [jxy, jyy, jyz], [jxz, jyz, jzz]])
    values, vectors = np.linalg.eigh(matrix)
    v = vectors[:, 0]
    if v[0] < 0 or (v[0] == 0 and (-v[1] < 0 or (v[1] == 0 and v[2] < 0))):
        v = -v
    l2, l3 = max(0.0, values[1]), max(0.0, values[0])
    coherency = (l2 - l3) / (l2 + l3) if l2 + l3 > 0 else 0.0
    azimuth = np.degrees(np.arctan2(-v[1], v[0]))
    if azimuth <= -90:
        azimuth += 180
    return v, float(azimuth), float(np.degrees(np.arcsin(np.clip(v[2], -1, 1)))), coherency


def grating(degrees, size=64, period=8):
    theta = np.radians(degrees)
    y, x = np.mgrid[0:size, 0:size].astype(float)
    return 100 + 50 * np.cos(2 * np.pi * (x * np.sin(theta) + y * np.cos(theta)) / period)


def direction(azimuth, elevation):
    a, e = np.radians(azimuth), np.radians(elevation)
    return np.array([np.cos(e) * np.cos(a), -np.cos(e) * np.sin(a), np.sin(e)])


def cylinders(size, spacing, azimuth, elevation, period=8):
    u = direction(azimuth, elevation)
    helper = np.array([0, 0, 1.0]) if abs(u[2]) < 0.9 else np.array([1.0, 0, 0])
    n1 = np.cross(u, helper)
    n1 /= np.linalg.norm(n1)
    n2 = np.cross(u, n1)
    n2 /= np.linalg.norm(n2)
    nx, ny, nz = size
    z, y, x = np.mgrid[0:nz, 0:ny, 0:nx].astype(float)
    px, py, pz = x * spacing[0], y * spacing[1], z * spacing[2]
    a = px * n1[0] + py * n1[1] + pz * n1[2]
    b = px * n2[0] + py * n2[1] + pz * n2[2]
    return 100 + 25 * np.cos(2 * np.pi * a / period) + 25 * np.cos(2 * np.pi * b / period)


def sample_points(nx, ny, count=8):
    """A count x count grid of pixels, inset from the border, as [x, y] pairs."""
    xs = np.linspace(nx * 0.05, nx * 0.95, count).round().astype(int)
    ys = np.linspace(ny * 0.05, ny * 0.95, count).round().astype(int)
    return [[int(x), int(y)] for y in ys for x in xs]


def main(example_path, output_path):
    reference = {
        "generator": "validation/scipy-reference.py",
        "numpy": np.__version__,
        "scipy": scipy.__version__,
        "gratings": [],
        "cylinders": [],
    }
    for degrees in [-75, -30, 0, 10, 45, 60, 90]:
        image = grating(degrees)
        components = tensor(image, 1.0, 4.0)
        orientation, coherency, energy = maps2d(*components)
        points = sample_points(64, 64, 4)
        reference["gratings"].append({
            "degrees": degrees, "sigma": 1.0, "rho": 4.0,
            "points": points,
            "orientation": [float(orientation[y, x]) for x, y in points],
            "coherency": [float(coherency[y, x]) for x, y in points],
            "energy": [float(energy[y, x]) for x, y in points],
        })
    for case in [
        {"size": [32, 32, 32], "spacing": [1, 1, 1], "azimuth": 30, "elevation": 20, "sigma": 1.0, "rho": 3.0},
        {"size": [32, 32, 32], "spacing": [1, 1, 1], "azimuth": 0, "elevation": 85, "sigma": 1.0, "rho": 3.0},
        {"size": [48, 48, 24], "spacing": [1, 1, 2], "azimuth": -60, "elevation": 45, "sigma": 2.0, "rho": 4.0},
    ]:
        image = cylinders(case["size"], case["spacing"], case["azimuth"], case["elevation"])
        components = tensor(image, case["sigma"], case["rho"], case["spacing"])
        nx, ny, nz = case["size"]
        points = [[nx // 2, ny // 2, nz // 2], [3, 5, 2], [nx - 4, 7, nz - 3]]
        rows = [fibre_vector([c[z, y, x] for c in components]) for x, y, z in points]
        reference["cylinders"].append({
            **case,
            "points": points,
            "vectors": [[float(v) for v in row[0]] for row in rows],
            "azimuth_deg": [row[1] for row in rows],
            "elevation_deg": [row[2] for row in rows],
            "coherency": [row[3] for row in rows],
            "energy": [float(components[0][z, y, x] + components[3][z, y, x] + components[5][z, y, x]) for x, y, z in points],
        })

    raw = open(example_path, "rb").read()
    image = tifffile.imread(example_path).astype(np.float64)
    ny, nx = image.shape
    components = tensor(image, SETTINGS["sigma"], SETTINGS["rho"])
    orientation, coherency, energy = maps2d(*components)
    selected = (coherency >= SETTINGS["minCoherency"]) & (energy >= SETTINGS["minEnergy"] * energy.max()) & (energy > 0)
    counts = np.zeros(180, dtype=int)
    bins = np.clip(np.floor(orientation[selected] + 90).astype(int), 0, 179)
    np.add.at(counts, bins, 1)
    dominant = maps2d(*[np.array([c.sum()]) for c in components])
    points = sample_points(nx, ny)
    reference["example"] = {
        "file": example_path.rsplit("/", 1)[-1],
        "sha256": hashlib.sha256(raw).hexdigest(),
        "dims": [nx, ny, 1],
        "settings": SETTINGS,
        "dominant": {"orientation": float(dominant[0][0]), "coherency": float(dominant[1][0])},
        "counted": int(selected.sum()),
        "histogram": counts.tolist(),
        "meanCoherency": float(coherency.mean()),
        "meanEnergy": float(energy.mean()),
        "points": points,
        "orientation": [float(orientation[y, x]) for x, y in points],
        "coherency": [float(coherency[y, x]) for x, y in points],
        "energy": [float(energy[y, x]) for x, y in points],
    }
    with open(output_path, "w") as handle:
        json.dump(reference, handle, indent=1)
        handle.write("\n")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
