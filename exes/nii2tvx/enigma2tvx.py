#!/usr/bin/env python3
"""
Convert the ENIGMA Symmetric White Matter Tractography Atlas to TVX against
MNI152_T1_1mm_brain_mask.nii.gz (looked up here, then in $FSLDIR/data/standard).
Per-bundle files land in enigma_symmetric_tvx/ and all of them packed into one
enigma_symmetric.tvx, next to this script.

    python3 enigma2tvx.py ~/src/ENIGMA_atlas

Download the atlas from https://zenodo.org/records/19656193 (CC BY 4.0) and unpack it, so the
directory holds MNI152_1mm/Full/trk. Use the 1 mm full set, not the 2 mm one: nii2tvx walks
every voxel a segment crosses, so 2 mm chords cut corners and visit voxels the streamline
never enters. Measured on the arcuate, a small deep lesion scored 0.0078 from the 2 mm source
against 0.0034 from the 1 mm source, and the 2 mm TVX was the larger file.
"""

import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path

MASK_NAME = "MNI152_T1_1mm_brain_mask.nii.gz"
TRK_SUBDIR = Path("MNI152_1mm/Full/trk")


def find_mask(base: Path) -> Path:
    for candidate in [base / MASK_NAME, Path(os.environ.get("FSLDIR", "")) / "data" / "standard" / MASK_NAME]:
        if candidate.exists():
            return candidate
    sys.exit(f"ERROR: {MASK_NAME} not found here or in $FSLDIR/data/standard")


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit(__doc__.strip())
    base = Path(__file__).resolve().parent
    exe = base / ("nii2tvx.exe" if platform.system() == "Windows" else "nii2tvx")
    if not exe.exists():
        sys.exit(f"ERROR: executable not found: {exe} (run make)")
    mask = find_mask(base)
    source = Path(sys.argv[1]).expanduser().resolve() / TRK_SUBDIR
    trks = sorted(source.glob("*.trk"))
    if not trks:
        sys.exit(f"ERROR: no .trk files under {source}")

    # nii2tvx writes each .tvx beside its input, so work on a copy and leave the atlas alone.
    work = base / "enigma_symmetric_trk"
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir()
    for trk in trks:
        shutil.copy2(trk, work / trk.name)

    print(f"Converting {len(trks)} bundles")
    subprocess.run([str(exe), str(mask), *(str(p) for p in sorted(work.glob("*.trk")))], cwd=base, check=True)

    tvx_dir = base / "enigma_symmetric_tvx"
    shutil.rmtree(tvx_dir, ignore_errors=True)
    tvx_dir.mkdir()
    for tvx in work.glob("*.tvx"):
        shutil.move(str(tvx), tvx_dir / tvx.name)
    shutil.rmtree(work, ignore_errors=True)
    subprocess.run([str(exe), "-p", str(base / "enigma_symmetric.tvx"), *(str(p) for p in sorted(tvx_dir.glob("*.tvx")))], check=True)
    print(f"Wrote {tvx_dir}")


if __name__ == "__main__":
    main()
