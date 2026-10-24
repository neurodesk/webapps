"""Print Markdown tables of run times, class volumes and geometry checks.

Usage: python -I summarize.py <runs dir> <run>/<subject> [<run>/<subject> ...]
"""

import json
import sys
from pathlib import Path

SLUGS = [
    "ventricles",
    "csf",
    "cerebellar-gm",
    "cerebellar-wm",
    "brainstem",
    "deep-gm",
    "cortical-gm",
    "wm",
    "wmh",
]


def main():
    root = Path(sys.argv[1])
    items = sys.argv[2:]
    print(
        "| Run | Subject | Preproc (s) | of which nlfit_s | BISON t1 (s) | BISON t1-flair (s) |"
    )
    print("| --- | --- | ---: | ---: | ---: | ---: |")
    for item in items:
        d = root / item
        t = {}
        for line in (d / "timings.tsv").read_text().splitlines():
            k, v = line.split("\t")
            t[k] = float(v)
        pre = sum(
            v
            for k, v in t.items()
            if not k.startswith(("geom", "t1_bison", "t1-flair", "t1_export"))
        )
        run, sub = item.split("/")
        print(
            f"| {run} | {sub} | {pre:.0f} | {t.get('t1_nlfit', 0):.0f} | "
            f"{t.get('t1_bison', 0):.0f} | {t.get('t1-flair_bison', 0):.0f} |"
        )
    for mode in ["t1", "t1-flair"]:
        cols = SLUGS[:8] if mode == "t1" else SLUGS
        print(f"\n{mode} class volumes (mL), label 0 voxels in the mask:\n")
        print("| Run | Subject | " + " | ".join(cols) + " | 0 |")
        print("| --- | --- |" + " ---: |" * (len(cols) + 1))
        for item in items:
            f = root / item / mode / "export" / "summary.json"
            if not f.exists():
                continue
            s = json.loads(f.read_text())
            v = s["volumes_ml"]
            run, sub = item.split("/")
            row = " | ".join(f"{v.get(c, 0):.1f}" for c in cols)
            print(f"| {run} | {sub} | {row} | {s['counts'].get('0', 0)} |")
    print(
        "\nGeometry (itk_resample Mask.mnc vs Mask_nl Dice; mean T1_VP in SP_1 > 0.5 / in mask):\n"
    )
    print(
        "| Run | Subject | forward Dice | forward ratio | inverse Dice | inverse ratio |"
    )
    print("| --- | --- | ---: | ---: | ---: | ---: |")
    for item in items:
        f = root / item / "geometry" / "geometry.json"
        if not f.exists():
            continue
        g = json.loads(f.read_text())["candidates"]
        run, sub = item.split("/")
        print(
            f"| {run} | {sub} | {g['forward']['dice_itk_mask_vs_mask_nl']:.3f} | "
            f"{g['forward']['ratio_to_mask_mean']:.2f} | "
            f"{g['inverse']['dice_itk_mask_vs_mask_nl']:.3f} | {g['inverse']['ratio_to_mask_mean']:.2f} |"
        )


if __name__ == "__main__":
    main()
