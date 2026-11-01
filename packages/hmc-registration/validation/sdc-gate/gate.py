"""The #462 field gate (Q66) for a replay on the 1.2 mm grid, with its memory and time.

    python -I gate.py SDC_REFERENCE REFERENCE_RUN RUN [--spread RUN ...] [--require] [--out JSON]

f is the workflow output `fmap` (node syn_sdc_wf/unwarp), "pre" the field before BSplineApprox
(node syn_sdc_wf/zooms_field), M the MindGrab mask of the mean b0. They are read, and the
median, 95th percentile and maximum over M of |f_a - f_b| computed, with the pinned
SDC_REFERENCE/scripts/compare_fields.py (on_grid, diff), as for the reference numbers.

REFERENCE_RUN is the native double seed-1234 run (SDC_GRID/runs/full-1.2mm-s1234-double-affine),
RUN a replay (replay.sh) or end-to-end run (e2e.sh) folder. d = median_M |f_RUN - f_REFERENCE|.
Each --spread RUN is a native double run at another seed on the same inputs; with them,
spread = the largest median_M over all pairs of {REFERENCE_RUN, spread runs}. The gate is
d <= max(spread, 0.05 Hz) and d < 0.5 Hz. Without --spread the first condition holds when
d <= 0.05 Hz, whatever the spread; otherwise it is undecided and the result says so.
--require exits 1 unless both conditions are decided and hold.
"""

import argparse
import importlib.util
import itertools
import json
import sys
from pathlib import Path

import nibabel as nb
import numpy as np

FMAP = "work/sdc_ref/syn_sdc_wf/unwarp/clipped_field.nii.gz"
PRE = "work/sdc_ref/syn_sdc_wf/zooms_field/fmap_syn0Warp_Hz_trans.nii.gz"
MASK = "mask/sub-01_dir-AP_run-001_desc-mindgrab_mask.nii.gz"
CAP_HZ = 0.5
FLOOR_HZ = 0.05


def load_compare_fields(reference):
    spec = importlib.util.spec_from_file_location(
        "compare_fields", Path(reference, "scripts/compare_fields.py")
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def calls(run):
    """The registration calls of a run: wall time and peak RSS, and the kernel's linear memory."""
    out = []
    timelog = Path(run, "ants-calls.jsonl")
    for line in timelog.open() if timelog.exists() else []:
        c = json.loads(line)
        if c["tool"] == "antsRegistration" and "--transform" in c["argv"]:
            out.append(
                {
                    "stage": "syn" if "fmap_syn" in " ".join(c["argv"]) else "epi2anat",
                    "wall_s": c["wall_s"],
                    "max_rss_GB": round(c["max_rss_kb"] * 1024 / 1e9, 3),
                    "exit": c["exit"],
                }
            )
    kernel = Path(run, "wasm-calls.jsonl")
    registrations = (
        [json.loads(line) for line in kernel.open()] if kernel.exists() else []
    )
    registrations = [c for c in registrations if c["program"] == "antsRegistration"]
    for entry, c in zip(out, registrations):
        entry.update(
            wasm_sha256=c["wasm_sha256"],
            wasm_heap_bytes=c["wasm_heap_bytes"],
            heap_growth=c.get("heap_growth"),
        )
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("reference")
    ap.add_argument("reference_run")
    ap.add_argument("run")
    ap.add_argument("--spread", nargs="*", default=[])
    ap.add_argument("--require", action="store_true")
    ap.add_argument("--out")
    args = ap.parse_args()
    cf = load_compare_fields(args.reference)
    mask_img = nb.load(Path(args.reference, MASK))
    M = np.asarray(mask_img.dataobj) > 0

    def field(run, rel):
        return cf.on_grid(Path(run, rel), mask_img)

    result = {
        "reference_run": str(args.reference_run),
        "run": str(args.run),
        "fmap": cf.diff(field(args.run, FMAP), field(args.reference_run, FMAP), M),
        "pre": cf.diff(field(args.run, PRE), field(args.reference_run, PRE), M),
        "registrations": calls(args.run),
    }
    d = result["fmap"]["median"]
    checks = {"d_below_cap": d < CAP_HZ}
    if args.spread:
        runs = [args.reference_run, *args.spread]
        pairs = {
            f"{Path(a).name}|{Path(b).name}": cf.diff(field(a, FMAP), field(b, FMAP), M)
            for a, b in itertools.combinations(runs, 2)
        }
        spread = max(p["median"] for p in pairs.values())
        result["spread"] = {"pairs": pairs, "median_max": spread}
        checks["d_within_spread_or_floor"] = d <= max(spread, FLOOR_HZ)
    else:
        result["spread"] = None
        # d <= floor implies d <= max(spread, floor) for any spread.
        checks["d_within_spread_or_floor"] = True if d <= FLOOR_HZ else None
    result["gate"] = {
        "d_hz": d,
        "cap_hz": CAP_HZ,
        "floor_hz": FLOOR_HZ,
        "checks": checks,
        "pass": all(v is True for v in checks.values()),
    }
    text = json.dumps(result, indent=2)
    if args.out:
        Path(args.out).write_text(text + "\n")
    print(text)
    if args.require and not result["gate"]["pass"]:
        sys.exit(f"gate failed: d = {d} Hz, checks {checks}")


if __name__ == "__main__":
    main()
