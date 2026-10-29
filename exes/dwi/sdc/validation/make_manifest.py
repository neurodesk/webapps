#!/usr/bin/env python3
"""Write a manifest of the sdc data on Hugging Face (sdc/reference/, its grid-q68/, or sdc/prior/).

    python3 exes/dwi/sdc/validation/make_manifest.py reference|prior|grid REVISION

REVISION is the 40-hex commit of neurodeskorg/webapps that holds the folder. The output is
reference.manifest.json, prior.manifest.json or grid.manifest.json beside this script; `grid`
is sdc/reference/grid-q68/, the Q68 runs on the 1.2 mm and 1.6 mm SyN grids. Each file's
sha256 comes from the folder's own SHA256SUMS at that commit (and, for SHA256SUMS itself, from the
downloaded bytes). Each file's size comes from the Hugging Face tree API at the same commit.
The subsets are SUBSETS below; a pattern is an fnmatch glob relative to the folder in which
`*` also crosses `/`. A pattern that matches no file is an error, so a typo or a re-pin
that drops files fails here. Standard library only.
"""

import fnmatch
import hashlib
import json
import os
import re
import sys
import urllib.request

REPOSITORY = "neurodeskorg/webapps"
HERE = os.path.dirname(os.path.abspath(__file__))
REF = "runs/full-2mm-s1234-double-affine/"
GRID_REF = "runs/full-1.2mm-s1234-double-affine/"
FOLDERS = {"reference": "reference", "prior": "prior", "grid": "reference/grid-q68"}

# What each later issue needs (plan docs/architecture/dwi-sdc-plan.md, section 6). Keep
# the patterns to `*` only.
SUBSETS = {
    "reference": {
        # The inputs of the full-brain gate (Q67), the masks and the Q59 transforms.
        "inputs": ["input/*", "mask/*", "std2anat/*"],
        # #463: the deterministic ports against the double seed-1234 2 mm run, and the
        # DWI unwarp with jacobian=True from its coefficients.
        "reference-run": ["input/*", "mask/*", "std2anat/affine/*", REF + "*"],
        "field-fit": [
            "input/sub-01_dir-AP_run-001_dwi.json",
            "mask/sub-01_dir-AP_run-001_desc-meanb0_dwiref.nii",
            "mask/sub-01_dir-AP_run-001_desc-mindgrab_mask.nii.gz",
            REF + "work/sdc_ref/syn_preprocessing_wf/sampling_ref/clipped_reference.nii.gz",
            REF + "work/sdc_ref/syn_sdc_wf/syn/fmap_syn0Warp.nii.gz",
            REF + "work/sdc_ref/syn_sdc_wf/extract_field/fmap_syn0Warp_Hz.nii.gz",
            REF + "work/sdc_ref/syn_sdc_wf/zooms_field/fmap_syn0Warp_Hz_trans.nii.gz",
            REF + "work/sdc_ref/syn_sdc_wf/bs_filter/fmap_syn0Warp_Hz_trans_coeff000.nii.gz",
            REF + "work/sdc_ref/syn_sdc_wf/bs_filter/fmap_syn0Warp_Hz_trans_field.nii.gz",
        ],
        # #462: the seed spread and the native float run of the Q66 gate, end to end and
        # SyN-only (the replays on the seed-1234 preprocessing outputs).
        "gate": [
            "input/*",
            "mask/*",
            "std2anat/affine/*",
            "runs/full-2mm-s*-double-affine/*",
            "runs/full-2mm-s1234-float-affine/*",
            "runs/full-2mm-synreplay-*/*",
            "compare/*",
        ],
        # #462 on the 1.2 mm grid (with grid.manifest.json): the replay's EPI reference, sidecar
        # and mask, the end-to-end inputs, and the pinned drivers, comparison and environment.
        "registration-gate": [
            "input/sub-01_dir-AP_run-001_dwi.json",
            "input/sub-01_run-001_T1w.nii.gz",
            "mask/sub-01_dir-AP_run-001_desc-meanb0_dwiref.nii",
            "mask/sub-01_dir-AP_run-001_desc-mindgrab_mask.nii.gz",
            "mask/sub-01_run-001_desc-mindgrab_mask.nii.gz",
            "std2anat/affine/std2anat_affine.mat",
            REF + "work/sdc_ref/syn_preprocessing_wf/epi_reference_wf/clip_bg_noise/*",
            "scripts/replay_syn.py",
            "scripts/sdc_driver.py",
            "scripts/compare_fields.py",
            "env/uv-pip-freeze.txt",
        ],
        # The same seed run twice (byte-identical outputs).
        "determinism": ["runs/*-repeat/*"],
        # Q68: the stock 0.8 mm grid.
        "grid-0.8mm": ["runs/full-0.8mm-*/*"],
        # Q59 and Q69.
        "prior-variants": [
            "std2anat/*",
            "runs/full-2mm-s1234-double-syn/*",
            "runs/full-2mm-s1234-double-none/*",
        ],
        "sloppy": ["runs/full-2mm-s1234-double-affine-sloppy/*"],
        # #464/#465: the slab with the full T1w.
        "slab": [
            "input/sub-01_run-001_T1w.*",
            "mask/slab/*",
            "mask/sub-01_run-001_desc-mindgrab_mask.nii.gz",
            "std2anat/affine/*",
            "runs/slab-*/*",
        ],
        "gre": ["gre/*"],
        "docs": ["README.md", "index.json", "compare/*", "env/*", "scripts/*"],
    },
    "prior": {
        "prior": ["*"],
    },
    "grid": {
        # #462: the 1.2 mm double seed-1234 run, whose kept preprocessing outputs the SyN-only
        # replay reads and whose `fmap` is the reference, and the 1.2 mm --float 1 runs.
        "replay-1.2mm": [
            GRID_REF + "node-outputs.json",
            GRID_REF + "work/*",
            "runs/full-1.2mm-s123*-float-affine/work/sdc_ref/syn_sdc_wf/unwarp/clipped_field.nii.gz",
            "runs/full-1.2mm-s1234-float-affine/work/sdc_ref/syn_sdc_wf/zooms_field/*",
            "runs/full-1.2mm-s1234-float-affine/work/sdc_ref/syn_preprocessing_wf/epi2anat/*",
        ],
        "grid-1.6mm": ["runs/full-1.6mm-*/*"],
        "docs": ["README.md", "compare/*", "scripts/*"],
    },
}


def get(url):
    with urllib.request.urlopen(url, timeout=120) as r:
        return r.read(), r.headers.get("Link")


def tree_sizes(revision, root):
    """Every file under root at revision and its size, following the API's pages."""
    url = f"https://huggingface.co/api/datasets/{REPOSITORY}/tree/{revision}/{root}?recursive=true"
    sizes = {}
    while url:
        body, link = get(url)
        for item in json.loads(body):
            if item["type"] == "file":
                sizes[item["path"][len(root) + 1 :]] = item["size"]
        match = re.search(r'<([^>]+)>;\s*rel="next"', link or "")
        url = match.group(1) if match else None
    return sizes


def matches(pattern, paths):
    if re.search(r"[?\[\]{}]", pattern):
        sys.exit(f"{pattern}: use only `*` in subset patterns")
    hit = [p for p in paths if fnmatch.fnmatchcase(p, pattern)]
    if not hit:
        sys.exit(f"{pattern}: matches no file at this revision")
    return hit


def main(folder, revision):
    if folder not in SUBSETS:
        sys.exit("folder is reference, prior or grid")
    if not re.fullmatch(r"[0-9a-f]{40}", revision):
        sys.exit("REVISION must be a full 40-hex commit")
    root = f"sdc/{FOLDERS[folder]}"
    base = f"https://huggingface.co/datasets/{REPOSITORY}/resolve/{revision}/{root}/"
    sums_bytes, _ = get(base + "SHA256SUMS")
    sums = {}
    for line in sums_bytes.decode().splitlines():
        digest, path = line.split(None, 1)
        sums[path.lstrip("*").removeprefix("./")] = digest
    sums["SHA256SUMS"] = hashlib.sha256(sums_bytes).hexdigest()
    sizes = tree_sizes(revision, root)
    if set(sizes) != set(sums):
        sys.exit(
            f"SHA256SUMS and the tree differ: {sorted(set(sizes) ^ set(sums))[:10]}"
        )
    paths = sorted(sizes)
    subsets = {}
    for name, patterns in SUBSETS[folder].items():
        files = sorted({p for pattern in patterns for p in matches(pattern, paths)})
        subsets[name] = {
            "patterns": patterns,
            "files": len(files),
            "bytes": sum(sizes[p] for p in files),
        }
    description = {
        "reference": "Native SyN-SDC reference runs (sdc/reference/, README.md there) for the sdc port "
        "(plan docs/architecture/dwi-sdc-plan.md). Fetch subsets with fetch_reference.py; "
        "regenerate with make_manifest.py.",
        "prior": "The SyN-SDC prior (sdc/prior/, README.md there): sdcflows' distortion atlas, its "
        "affine to MNI152NLin2009cAsym and the 1 mm template T1w and brain mask, with their notices. "
        "Fetch with fetch_reference.py --folder prior; regenerate with make_manifest.py.",
        "grid": "The Q68 middle-grid runs (sdc/reference/grid-q68/, README.md there): native SyN-SDC on "
        "the 1.2 mm and 1.6 mm SyN grids, the inputs and reference of #462's 1.2 mm precision test. "
        "Fetch with fetch_reference.py --folder grid; regenerate with make_manifest.py.",
    }[folder]
    manifest = {
        "description": description,
        "repository": REPOSITORY,
        "revision": revision,
        "base": base,
        "subsets": subsets,
        "files": [{"path": p, "bytes": sizes[p], "sha256": sums[p]} for p in paths],
    }
    # One file per line keeps a re-pin reviewable as a line diff.
    head = json.dumps({k: v for k, v in manifest.items() if k != "files"}, indent=2)
    lines = ",\n".join(
        "    " + json.dumps(entry, separators=(", ", ": "))
        for entry in manifest["files"]
    )
    out = os.path.join(HERE, f"{folder}.manifest.json")
    with open(out, "w") as f:
        f.write(head[:-2] + ',\n  "files": [\n' + lines + "\n  ]\n}\n")
    for name, s in subsets.items():
        print(f"{name}: {s['files']} files, {s['bytes'] / 1e6:.1f} MB")
    print(
        f"{out}: {len(paths)} files, {sum(sizes.values()) / 1e6:.1f} MB at {revision[:12]}"
    )


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
