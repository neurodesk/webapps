"""Combine every subject's metrics into the document's tables and apply the gate.

The issue #471 gate requires AP-PA at most 1.1 times topup's and T1w
alignment no worse than topup's on every subject. The unaccepted proposals
with a 1.02 BBR ratio and topup-single spread are printed separately.

Usage: aggregate.py <runs-dir> [subject...]

Prints Markdown: one row per method and subject, then one row per method with
the image gate result, the mean demeaned Δfield and the mean run time.
"""

import json
import sys
from pathlib import Path

AP_PA_LIMIT = 1.1
BBR_LIMIT = 1.0
PROPOSED_BBR_LIMIT = 1.02
SUBJECTS = (
    "ds005134-sub-01",
    "ds004146-sub-0001",
    "ds004146-sub-0002",
    "ds004146-sub-0003",
    "ds004146-sub-0004",
    "ds004146-sub-0005",
)
ORDER = [
    "topup",
    "topup-single",
    "drbuddi",
    "pyhysco",
    "pyhysco-gpu",
    "fdnet",
    "fdnet-pa-first",
    "ants",
    "qwarp",
]


def fmt(value, digits=3):
    return "" if value is None else f"{value:.{digits}g}"


def average(rows, key):
    return sum(r[key] for r in rows) / len(rows)


def main(runs, *subjects):
    runs = Path(runs)
    if not subjects:
        subjects = SUBJECTS
    missing = [sub for sub in subjects if not (runs / sub / "summary.json").is_file()]
    if missing:
        raise SystemExit("Missing subject results: " + ", ".join(missing))
    table = {}
    for sub in subjects:
        rows = {
            m["method"]: m
            for m in json.loads((runs / sub / "summary.json").read_text())
        }
        table[sub] = rows

    print(
        "| Subject | Method | AP-PA | AP-PA, no Jacobian | BBR | Δfield (Hz) | Δfield demeaned (Hz) | r | Δ GRE demeaned (Hz) | Time (s) | Peak RAM (MB) | Image gate |"
    )
    print("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |")
    passes = {}
    proposed_passes = {}
    proposed_fixed_passes = {}
    for sub, rows in table.items():
        ref = rows["topup"]
        # These wider limits are proposals only. They do not set acceptance.
        single = rows["topup-single"]
        appa_limit = max(AP_PA_LIMIT, single["appa_mad"] / ref["appa_mad"])
        bbr_limit = max(PROPOSED_BBR_LIMIT, single["bbr_cost"] / ref["bbr_cost"])
        for method in ORDER:
            m = rows.get(method)
            if m is None:
                continue
            ok = (
                m["appa_mad"] <= AP_PA_LIMIT * ref["appa_mad"]
                and m["bbr_cost"] <= BBR_LIMIT * ref["bbr_cost"]
            )
            proposed = (
                m["appa_mad"] <= appa_limit * ref["appa_mad"]
                and m["bbr_cost"] <= bbr_limit * ref["bbr_cost"]
            )
            proposed_fixed = (
                m["appa_mad"] <= AP_PA_LIMIT * ref["appa_mad"]
                and m["bbr_cost"] <= PROPOSED_BBR_LIMIT * ref["bbr_cost"]
            )
            passes.setdefault(method, []).append(ok)
            proposed_passes.setdefault(method, []).append(proposed)
            proposed_fixed_passes.setdefault(method, []).append(proposed_fixed)
            print(
                f"| {sub} | {method} | {fmt(m['appa_mad'])} | {fmt(m.get('appa_mad_nojac'))} "
                f"| {fmt(m['bbr_cost'], 4)} | {fmt(m['field_vs_topup_mad_hz'])} "
                f"| {fmt(m['field_vs_topup_mad_demeaned_hz'])} | {fmt(m['field_vs_topup_r'])} "
                f"| {fmt(m.get('field_vs_gre_mad_demeaned_hz'))} | {fmt(m.get('wall_s'))} "
                f"| {fmt(m.get('peak_rss_mb'))} | {'pass' if ok else 'fail'} |"
            )

    print()
    print(
        "| Method | Issue #471 gate | Proposed spread limits | Proposed fixed limits | Mean Δfield demeaned (Hz) | Mean Δfield (Hz) | Mean r | Mean time (s) | Max peak RAM (MB) |"
    )
    print("| --- | --- | --- | --- | --- | --- | --- | --- | --- |")
    means = {}
    for method in ORDER:
        vals = [rows[method] for rows in table.values() if method in rows]
        if not vals:
            continue
        means[method] = average(vals, "field_vs_topup_mad_demeaned_hz")
        times = [v["wall_s"] for v in vals if "wall_s" in v]
        rams = [v["peak_rss_mb"] for v in vals if "peak_rss_mb" in v]
        print(
            f"| {method} | {sum(passes[method])}/{len(table)} "
            f"| {sum(proposed_passes[method])}/{len(table)} "
            f"| {sum(proposed_fixed_passes[method])}/{len(table)} "
            f"| {fmt(means[method])} | {fmt(average(vals, 'field_vs_topup_mad_hz'))} "
            f"| {fmt(average(vals, 'field_vs_topup_r'))} "
            f"| {fmt(sum(times) / len(times)) if times else ''} | {fmt(max(rams)) if rams else ''} |"
        )

    candidates = [
        m
        for m in ORDER
        if m not in ("topup", "topup-single", "pyhysco-gpu", "fdnet-pa-first")
        and m in passes
        and len(passes[m]) == len(table)
        and all(passes[m])
    ]
    print()
    if not candidates:
        print("No candidate passes the image gate on every subject.")
        return
    closest = min(candidates, key=means.get)
    print(f"Passing every subject: {', '.join(candidates)}.")
    print(f"Closest by mean demeaned Δfield: {closest} ({means[closest]:.3g} Hz).")
    print("Choice follows issue #471: the cheapest port among the passing methods.")


if __name__ == "__main__":
    main(*sys.argv[1:])
