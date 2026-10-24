"""Download the OpenNeuro inputs listed in subjects.json and verify them.

Usage: python -I fetch_subjects.py <subjects.json> <data-dir> [subject ...]

Each file goes to <data-dir>/<subject>/<file name>. The script checks the byte
count and the sha256 from subjects.json and stops on a mismatch. A file that is
already present and correct is not downloaded again.
"""

import hashlib
import json
import os
import sys
import urllib.request
from pathlib import Path


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main():
    spec = json.loads(Path(sys.argv[1]).read_text())
    data_dir = sys.argv[2]
    wanted = set(sys.argv[3:])
    for sub in spec["subjects"]:
        if wanted and sub["id"] not in wanted:
            continue
        sub_dir = os.path.join(data_dir, sub["id"])
        os.makedirs(sub_dir, exist_ok=True)
        for mod, f in sub["files"].items():
            dest = os.path.join(sub_dir, os.path.basename(f["path"]))
            if not (os.path.exists(dest) and sha256(dest) == f["sha256"]):
                tmp = dest + ".part"
                with urllib.request.urlopen(f["url"]) as r, open(tmp, "wb") as o:
                    while chunk := r.read(1 << 20):
                        o.write(chunk)
                os.replace(tmp, dest)
            size = os.path.getsize(dest)
            digest = sha256(dest)
            if size != f["bytes"] or digest != f["sha256"]:
                raise SystemExit(
                    f"{dest}: {size} bytes sha256 {digest}, expected {f['bytes']} {f['sha256']}"
                )
            print(f"{sub['id']} {mod} {size} {digest} OK")


if __name__ == "__main__":
    main()
