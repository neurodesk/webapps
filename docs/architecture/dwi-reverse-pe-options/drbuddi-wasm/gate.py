"""Apply the strict #471 image gate to every scored DR-BUDDI variant.

Usage: gate.py BASE [OUT_JSON]

BASE holds eval/<variant>/runs/<subject>/{drbuddi,topup}/metrics.json (from
evaluate-run.sh), runs/<engine>/<schedule>/<subject>/receipt.json and
../reverse-pe/runs (the #471 runs, for the archived QSIPrep DR-BUDDI row).
The gate, per subject: AP-PA MAD <= 1.1 x topup's and BBR cost <= topup's,
both from the exact values; a variant passes only when every one of the six
subjects passes. Prints a Markdown table and writes the rows as JSON.
"""

import json
import sys
from pathlib import Path

SUBJECTS = [
    "ds005134-sub-01",
    "ds004146-sub-0001",
    "ds004146-sub-0002",
    "ds004146-sub-0003",
    "ds004146-sub-0004",
    "ds004146-sub-0005",
]


LABELS = {
    "native": "probe, 2 mm grid, native x86-64",
    "chromium": "probe, 2 mm grid, Chromium",
    "nativequad": "probe, QSIPrep quad grid, native x86-64",
    "chromiumquad": "probe, QSIPrep quad grid, Chromium",
    "qsiprep": "QSIPrep DRBUDDI (quad grid + rigid), 1 thread",
}
ARCHIVED = "QSIPrep DRBUDDI (quad grid + rigid), 8 threads, default (archived #471)"


def label(name):
    engine, _, sched = name.partition("-")
    return f"{LABELS.get(engine, engine)}, {sched}"


def load(path):
    return json.loads(Path(path).read_text()) if Path(path).is_file() else None


def row(variant, sub, cand, topup, receipt=None):
    r = {"variant": variant, "subject": sub}
    if not cand or not topup or "bbr_cost" not in cand:
        r["pass"] = False
        r["missing"] = True
        return r
    r.update(
        appa_mad=cand["appa_mad"],
        topup_appa_mad=topup["appa_mad"],
        appa_ratio=cand["appa_mad"] / topup["appa_mad"],
        bbr_cost=cand["bbr_cost"],
        topup_bbr_cost=topup["bbr_cost"],
        bbr_ratio=cand["bbr_cost"] / topup["bbr_cost"],
        field_vs_topup_mad_demeaned_hz=cand["field_vs_topup_mad_demeaned_hz"],
    )
    r["appa_pass"] = cand["appa_mad"] <= 1.1 * topup["appa_mad"]
    r["bbr_pass"] = cand["bbr_cost"] <= topup["bbr_cost"]
    r["pass"] = r["appa_pass"] and r["bbr_pass"]
    if receipt:
        r["wall_s"] = receipt["elapsedMs"] / 1000
        if "peakRssBytes" in receipt:
            r["peak_rss_mb"] = receipt["peakRssBytes"] / 2**20
        if "heapBytes" in receipt:
            r["wasm_heap_bytes"] = receipt["heapBytes"]
        r["iterations"] = receipt.get("iterations")
    elif "wall_s" in cand:
        r["wall_s"] = cand["wall_s"]
        r["peak_rss_mb"] = cand.get("peak_rss_mb")
    return r


def main(base, out=None):
    base = Path(base).resolve()
    rows = []
    archived = base.parent / "reverse-pe" / "runs"
    for sub in SUBJECTS:
        rows.append(
            row(
                ARCHIVED,
                sub,
                load(archived / sub / "drbuddi" / "metrics.json"),
                load(archived / sub / "topup" / "metrics.json"),
            )
        )
    for ev in sorted((base / "eval").iterdir()):
        engine, _, sched = ev.name.partition("-")
        for sub in SUBJECTS:
            run = ev / "runs" / sub
            if not run.is_dir():
                continue
            receipt = load(base / "runs" / engine / sched / sub / "receipt.json")
            rows.append(
                row(
                    label(ev.name),
                    sub,
                    load(run / "drbuddi" / "metrics.json"),
                    load(run / "topup" / "metrics.json"),
                    receipt,
                )
            )
    # Every re-scored topup must equal the archived #471 topup exactly.
    for ev in sorted((base / "eval").iterdir()):
        for run in sorted((ev / "runs").iterdir()):
            new = load(run / "topup" / "metrics.json")
            old = load(archived / run.name / "topup" / "metrics.json")
            for key in ("bbr_cost", "appa_mad"):
                if new[key] != old[key]:
                    sys.exit(
                        f"{ev.name} {run.name}: topup {key} {new[key]} != {old[key]}"
                    )
    variants = list(dict.fromkeys(r["variant"] for r in rows))
    print(
        "| Variant | Subjects scored | AP-PA pass | BBR pass | Both pass | Gate (6/6) | BBR ratio range | Mean demeaned Δfield (Hz) | Max wall (s) | Max RSS (MB) or WASM heap (bytes) |"
    )
    print("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |")
    for v in variants:
        rs = [r for r in rows if r["variant"] == v and not r.get("missing")]
        if not rs:
            continue
        bbr = [r["bbr_ratio"] for r in rs]
        walls = [r.get("wall_s") or 0 for r in rs]
        heap = max((r.get("wasm_heap_bytes") or 0) for r in rs)
        rss = max((r.get("peak_rss_mb") or 0) for r in rs)
        mem = f"heap {heap}" if heap else f"RSS {rss:.0f}"
        gate = len(rs) == 6 and all(r["pass"] for r in rs)
        print(
            f"| {v} | {len(rs)} | {sum(r['appa_pass'] for r in rs)} | {sum(r['bbr_pass'] for r in rs)} | {sum(r['pass'] for r in rs)} | "
            f"{'pass' if gate else 'fail'} | {min(bbr):.4f}-{max(bbr):.4f} | "
            f"{sum(r['field_vs_topup_mad_demeaned_hz'] for r in rs) / len(rs):.2f} | {max(walls):.0f} | {mem} |"
        )
    print()
    print(
        "| Variant | Subject | AP-PA / topup | BBR | topup BBR | BBR / topup | Pass |"
    )
    print("| --- | --- | --- | --- | --- | --- | --- |")
    for r in rows:
        if r.get("missing"):
            continue
        print(
            f"| {r['variant']} | {r['subject']} | {r['appa_ratio']:.3f} | {r['bbr_cost']:.6f} | "
            f"{r['topup_bbr_cost']:.6f} | {r['bbr_ratio']:.4f} | {'yes' if r['pass'] else 'no'} |"
        )
    if out:
        Path(out).write_text(json.dumps(rows, indent=2) + "\n")


if __name__ == "__main__":
    main(*sys.argv[1:])
