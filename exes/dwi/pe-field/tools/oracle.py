"""Write tests/fixtures/qsiprep.json from QSIPrep 26.1.1's own code, for tests/oracle.rs.

    python -I tools/oracle.py QSIPREP_CHECKOUT tests/fixtures/topup.json tests/fixtures/qsiprep.json

QSIPREP_CHECKOUT is a clone of PennLINC/qsiprep at tag 26.1.1. The script takes
`TopupFieldToWarp._run_interface` (`qsiprep/interfaces/fmap.py`) and `jacobian_determinant`
with `_field_components` (`qsiprep/interfaces/jacobian.py`) unchanged from the checkout, with
stand-ins for the nipype and nilearn helpers they call, so it needs neither package. It runs
them on case A of topup.json (topup's `--fout` field) on its own grid and on an oblique grid,
both with a negative determinant, as QSIPrep always gives TOPUP an LAS+ image.

Use the QSIPrep 26.1.1 container's numerical stack (see exes/dwi/shore/README.md)."""

import ast
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import types

import nibabel as nb
import numpy as np

src, topup_json, out = sys.argv[1], sys.argv[2], sys.argv[3]
fmap_py = os.path.join(src, "qsiprep", "interfaces", "fmap.py")
jacobian_py = os.path.join(src, "qsiprep", "interfaces", "jacobian.py")


def definitions(path, names):
    """The named top-level functions and class methods of a file, unchanged."""
    tree = ast.parse(open(path).read())
    found = {}
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name in names:
            found[node.name] = node
        if isinstance(node, ast.ClassDef):
            for item in node.body:
                key = f"{node.name}.{getattr(item, 'name', '')}"
                if isinstance(item, ast.FunctionDef) and key in names:
                    found[key] = item
    missing = set(names) - set(found)
    if missing:
        raise SystemExit(f"{path} has no {sorted(missing)}")
    return found


def fname_presuffix(fname, suffix="", newpath=None, use_ext=True):
    # nipype.utils.filemanip.fname_presuffix, for the paths these functions build.
    base = os.path.basename(fname)
    for ext in (".nii.gz", ".nii"):
        if base.endswith(ext):
            base, extension = base[: -len(ext)], ext
            break
    else:
        extension = ""
    return os.path.join(newpath, base + suffix + (extension if use_ext else ""))


class Logger:
    def warning(self, *args):
        pass


namespace = {
    "nb": nb,
    "np": np,
    "image": types.SimpleNamespace(index_img=lambda img, i: img.slicer[..., i]),
    "fname_presuffix": fname_presuffix,
    "LOGGER": Logger(),
    "_report_nonpositive": lambda *args: None,
}
fmap = definitions(fmap_py, ["_reorient", "TopupFieldToWarp._run_interface"])
jac = definitions(jacobian_py, ["_field_components", "jacobian_determinant"])
for node in [fmap["_reorient"], jac["_field_components"], jac["jacobian_determinant"]]:
    exec(compile(ast.Module([node], []), "qsiprep", "exec"), namespace)
method = fmap["TopupFieldToWarp._run_interface"]
method.name = "topup_field_to_warp"
exec(compile(ast.Module([method], []), fmap_py, "exec"), namespace)

topup = json.load(open(topup_json))
case = next(c for c in topup["cases"] if c["name"] == "A")
dims = tuple(case["dims"])
hz = np.array(case["fout"], np.float32).reshape(dims, order="F")
oblique = np.array(case["affine"])
c, s = np.cos(0.3), np.sin(0.3)
rotation = np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]]) @ np.array([[1, 0, 0], [0, np.cos(0.2), -np.sin(0.2)], [0, np.sin(0.2), np.cos(0.2)]])
oblique[:3, :3] = rotation @ oblique[:3, :3]

def float32_list(a):
    # The shortest decimal that reads back as the same float32 value.
    return [float(repr(x)) for x in np.asarray(a, np.float32).ravel()]


results = []
with tempfile.TemporaryDirectory() as work:
    datain = os.path.join(work, "datain.txt")
    with open(datain, "w") as f:
        f.writelines(" ".join(str(x) for x in r) + "\n" for r in case["datain"])
    for label, affine in (("axis-aligned", np.array(case["affine"])), ("oblique", oblique)):
        field = os.path.join(work, f"{label}_hz.nii.gz")
        nb.Nifti1Image(hz, affine).to_filename(field)
        node = types.SimpleNamespace(
            inputs=types.SimpleNamespace(fieldmap=field, datain=datain, reference=field), _results={}
        )
        namespace["topup_field_to_warp"](node, types.SimpleNamespace(cwd=work))
        warp = nb.load(node._results["out_warp"])
        pe_axis = node._results["pe_axis"]
        jac_file = namespace["jacobian_determinant"](node._results["out_warp"], os.path.join(work, f"{label}_jac.nii.gz"), pe_axis)
        displacement = np.asarray(warp.dataobj)[:, :, :, 0, :]
        results.append({
            "label": label,
            "affine": affine.tolist(),
            "pe_axis": pe_axis,
            "displacement": float32_list(displacement.reshape(-1, 3, order="F")),
            "jacobian": float32_list(np.asarray(nb.load(jac_file).dataobj).ravel(order="F")),
        })


def sha256(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


provenance = {
    "qsiprep_commit": subprocess.run(["git", "-C", src, "rev-parse", "HEAD"], capture_output=True, text=True, check=True).stdout.strip(),
    "sha256": {"fmap.py": sha256(fmap_py), "jacobian.py": sha256(jacobian_py)},
    "numpy": np.__version__,
    "nibabel": nb.__version__,
}
with open(out, "w") as f:
    json.dump({"provenance": provenance, "case": "A", "datain": case["datain"], "grids": results}, f, separators=(",", ":"))
    f.write("\n")
