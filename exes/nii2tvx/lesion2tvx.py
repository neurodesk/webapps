#!/usr/bin/env python3
# Usage:
#   python lesion2tvx.py /path/to/lesions /path/to/tvx [-o results.tsv] [--lesion-pattern "wsub*_desc-lesion_mask.nii.gz"]
#
# Finds lesion NIfTI images under the first directory and all .tvx files under the
# second (both recursively) and runs the 'nii2tvx' executable next to this script
# once with all of them. With -o, the TSV is rewritten with SUBJECT/SESSION columns
# parsed from BIDS-style sub-XXXX[_ses-YY] names.

import argparse
import re
import subprocess
import sys
from pathlib import Path


def extract_subject_session(fp: str):
    for part in Path(fp).parts[::-1]:  # nearest folder or file name wins
        m = re.match(r"sub-([A-Za-z0-9]+)(?:_ses-([0-9]+))?", part)
        if m:
            return m.group(1), m.group(2) or "1"
    return Path(fp).name, "1"


def naturalsort_key(s: str):
    return [int(text) if text.isdigit() else text.lower() for text in re.split(r"(\d+)", s)]


def collect_files(root: Path, pattern: str) -> list[Path]:
    return sorted(root.rglob(pattern), key=lambda p: naturalsort_key(str(p)))


def main():
    ap = argparse.ArgumentParser(description="Run nii2tvx with all lesions and tracks.")
    ap.add_argument("lesions_dir", type=Path, help="Directory containing lesion files (searched recursively)")
    ap.add_argument("tvx_dir", type=Path, help="Directory containing .tvx files (searched recursively)")
    ap.add_argument("-o", "--out", type=Path, default=None, help="Write TSV with SUBJECT/SESSION columns to this file")
    ap.add_argument("--lesion-pattern", default="*.nii.gz", help="Glob for lesion files (default: *.nii.gz)")
    args = ap.parse_args()

    lesions = collect_files(args.lesions_dir.resolve(), args.lesion_pattern)
    tvxs = collect_files(args.tvx_dir.resolve(), "*.tvx")
    if not lesions:
        ap.error(f"No lesion files matching '{args.lesion_pattern}' under: {args.lesions_dir}")
    if not tvxs:
        ap.error(f"No .tvx files under: {args.tvx_dir}")

    exe = Path(__file__).resolve().parent / "nii2tvx"
    if not exe.exists():
        sys.exit(f"ERROR: executable not found: {exe} (run make)")
    cmd = [str(exe), *map(str, lesions), *map(str, tvxs)]

    if not args.out:
        return subprocess.run(cmd).returncode

    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if proc.returncode != 0:
        sys.stderr.write(proc.stderr + f"\nnii2tvx exited with code {proc.returncode}\n")
        return proc.returncode
    lines = proc.stdout.strip().splitlines()
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("w", encoding="utf-8") as f:
        f.write("\t".join(["SUBJECT", "SESSION"] + lines[0].split("\t")[1:]) + "\n")
        for line in lines[1:]:
            cols = line.split("\t")
            f.write("\t".join([*extract_subject_session(cols[0]), *cols[1:]]) + "\n")
    print(f"Wrote: {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
