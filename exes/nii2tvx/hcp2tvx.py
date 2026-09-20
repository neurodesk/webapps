#!/usr/bin/env python3
"""
Download the HCP1065 population-averaged tractography atlas (TRK) and convert every
tract to TVX against MNI152_T1_1mm_brain_mask.nii.gz (looked up here, then in
$FSLDIR/data/standard). Per-tract files land in hcp1065_avg_tracts_tvx/ and all of
them packed into one hcp1065_avg_tracts.tvx, next to this script.
Both data folders are deleted and recreated on every run.
"""

import gzip
import os
import platform
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path
from urllib.request import urlretrieve

ZIP_URL = "https://github.com/frankyeh/data-atlas/releases/download/hcp1065/hcp1065_avg_tracts_trk.zip"
MASK_NAME = "MNI152_T1_1mm_brain_mask.nii.gz"


def find_mask(base: Path) -> Path:
    for candidate in [base / MASK_NAME, Path(os.environ.get("FSLDIR", "")) / "data" / "standard" / MASK_NAME]:
        if candidate.exists():
            return candidate
    sys.exit(f"ERROR: {MASK_NAME} not found here or in $FSLDIR/data/standard")


def main() -> None:
    base = Path(__file__).resolve().parent
    exe = base / ("nii2tvx.exe" if platform.system() == "Windows" else "nii2tvx")
    if not exe.exists():
        sys.exit(f"ERROR: executable not found: {exe} (run make)")
    mask = find_mask(base)
    zip_path = base / "hcp1065_avg_tracts_trk.zip"
    trk_dir = base / "hcp1065_avg_tracts_trk"
    tvx_dir = base / "hcp1065_avg_tracts_tvx"

    if not zip_path.exists():
        print(f"Downloading {ZIP_URL}")
        urlretrieve(ZIP_URL, zip_path.with_suffix(".part"))
        zip_path.with_suffix(".part").rename(zip_path)  # an interrupted download must not look complete

    shutil.rmtree(trk_dir, ignore_errors=True)
    trk_dir.mkdir()
    with zipfile.ZipFile(zip_path) as zf:
        zf.extractall(trk_dir)
    for gz in trk_dir.rglob("*.gz"):
        with gzip.open(gz, "rb") as f_in, open(gz.with_suffix(""), "wb") as f_out:
            shutil.copyfileobj(f_in, f_out)

    trks = sorted(trk_dir.rglob("*.trk"))
    if not trks:
        sys.exit(f"ERROR: no .trk files under {trk_dir}")
    print(f"Converting {len(trks)} tracts")
    subprocess.run([str(exe), str(mask), *map(str, trks)], cwd=base, check=True)

    shutil.rmtree(tvx_dir, ignore_errors=True)
    tvx_dir.mkdir()
    for tvx in trk_dir.rglob("*.tvx"):
        shutil.move(str(tvx), tvx_dir / tvx.name)
    subprocess.run([str(exe), "-p", str(base / "hcp1065_avg_tracts.tvx"), *map(str, sorted(tvx_dir.glob("*.tvx")))], check=True)
    print(f"Wrote {tvx_dir}")


if __name__ == "__main__":
    main()
