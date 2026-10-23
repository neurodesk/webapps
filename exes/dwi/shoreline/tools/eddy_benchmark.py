"""Benchmark `shoreline` and FSL eddy against ground truth on synthetic phantoms.

    SHORELINE_PHANTOM_DIR=DIR cargo test --release -p dwi-shoreline --test synthetic export_phantoms -- --ignored
    python -I tools/eddy_benchmark.py DIR SHORELINE_BINARY [SCHEME ...]

SHORELINE_ARGS adds options to the shoreline command (for example "--model=gp").

FSL is a reference tool here (`eddy_cpu` on PATH, FSLDIR set), never ported or shipped. Each
phantom (tests/synthetic.rs) is a series moved, distorted by a known susceptibility field and
known eddy-current fields, with dropped slices; both tools get the same series, mask,
gradients, acquisition parameters and field (Hz), with eddy's settings
`--flm=quadratic --slm=linear --repol --fwhm=2 --niter=5`. The score is the relative RMS
difference between each corrected series and the true images over the mask (diffusion-weighted
volumes, and all volumes); lower is better.
"""

import json
import os
import subprocess
import sys
import time

import nibabel as nb
import numpy as np

directory, binary = sys.argv[1], sys.argv[2]
names = sys.argv[3:] or sorted(f[:-5] for f in os.listdir(directory) if f.endswith(".json") and f != "benchmark.json")


def raw(path, shape):
    return np.fromfile(path, dtype="<f4").reshape(shape, order="F")


results = {}
for name in names:
    meta = json.load(open(os.path.join(directory, f"{name}.json")))
    dims = meta["dims"]
    nv = len(meta["bvals"])
    work = os.path.join(directory, f"{name}_work")
    os.makedirs(work, exist_ok=True)
    # Negative determinant (radiological): FSL's voxel axes are the file's, so the gradients
    # and phase-encoding vectors need no flip.
    affine = np.diag([-meta["voxel"], meta["voxel"], meta["voxel"], 1.0])
    series = raw(os.path.join(directory, f"{name}_series.f32"), (*dims, nv))
    truth = raw(os.path.join(directory, f"{name}_truth.f32"), (*dims, nv))
    mask = raw(os.path.join(directory, f"{name}_mask.f32"), tuple(dims)) > 0.5
    field = raw(os.path.join(directory, f"{name}_field.f32"), tuple(dims))
    p = lambda f: os.path.join(work, f)
    nb.Nifti1Image(series, affine).to_filename(p("dwi.nii.gz"))
    nb.Nifti1Image(mask.astype(np.float32), affine).to_filename(p("mask.nii.gz"))
    nb.Nifti1Image(field.astype(np.float32), affine).to_filename(p("field.nii.gz"))
    np.savetxt(p("bvals"), np.array(meta["bvals"])[None], fmt="%g")
    np.savetxt(p("bvecs"), np.array(meta["bvecs"]).T, fmt="%.6f")
    rows, index = [], []
    for axis, sign, readout in meta["acquisitions"]:
        v = [0, 0, 0]
        v[int(axis)] = int(sign)
        row = f"{v[0]} {v[1]} {v[2]} {readout}"
        if row not in rows:
            rows.append(row)
        index.append(rows.index(row) + 1)
    open(p("acqp"), "w").write("\n".join(rows) + "\n")
    open(p("index"), "w").write(" ".join(map(str, index)) + "\n")
    common = [f"--imain={p('dwi.nii.gz')}", f"--mask={p('mask.nii.gz')}", f"--acqp={p('acqp')}", f"--index={p('index')}",
              f"--bvecs={p('bvecs')}", f"--bvals={p('bvals')}", "--flm=quadratic", "--slm=linear", "--repol", "--fwhm=2", "--niter=5"]
    slspec = os.path.join(directory, f"{name}.slspec")
    s2v = [f"--slspec={slspec}", "--mporder=4"] if os.path.exists(slspec) else []
    # Slices acquired together (several per slspec row, which give both tools the groups;
    # eddy refuses --mb with --slspec): multiband, with group-wise outliers.
    if s2v and any(len(row.split()) > 1 for row in open(slspec)):
        s2v.append("--ol_type=gw")
    timings = {}
    if not os.path.exists(p("eddy.nii.gz")):
        t = time.time()
        subprocess.run(["eddy_cpu", *common, f"--field={p('field')}", f"--out={p('eddy')}", "--data_is_shelled", *s2v],
                       check=True, stdout=subprocess.DEVNULL)
        timings["eddy_s"] = time.time() - t
    t = time.time()
    subprocess.run([binary, *common, f"--field={p('field.nii.gz')}", f"--out={p('shoreline')}", "--nthr=8", *s2v,
                    *os.environ.get("SHORELINE_ARGS", "").split()],
                   check=True, stderr=subprocess.DEVNULL)
    timings["shoreline_s"] = time.time() - t
    dwi = np.array(meta["bvals"]) > 0

    def error(data, volumes):
        d, t_ = data[mask][:, volumes], truth[mask][:, volumes]
        return float(np.sqrt(np.sum((d - t_) ** 2) / np.sum(t_ ** 2)))

    out = {"volumes": nv, "dwi": int(dwi.sum()), **timings}
    for tool, data in (("uncorrected", series), ("eddy", nb.load(p("eddy.nii.gz")).get_fdata(dtype=np.float32)),
                       ("shoreline", nb.load(p("shoreline.nii.gz")).get_fdata(dtype=np.float32))):
        out[tool] = {"dwi": error(data, dwi), "all": error(data, np.ones(nv, bool))}
    results[name] = out
    print(f"{name:10s} ({nv} volumes): image error, diffusion-weighted / all: "
          + "  ".join(f"{t} {out[t]['dwi']:.4f}/{out[t]['all']:.4f}" for t in ("uncorrected", "eddy", "shoreline")))
json.dump(results, open(os.path.join(directory, "benchmark.json"), "w"), indent=1)
