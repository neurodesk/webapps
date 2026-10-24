#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Fetch the pinned dmipy reference: python3 fetch_reference.py DEST."""
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "validation"))
from fetch_oracle import download

if len(sys.argv) != 2:
    raise SystemExit(__doc__)
destination = Path(sys.argv[1]).resolve()
manifest = json.loads(Path(__file__).with_name("reference.manifest.json").read_text())
for entry in manifest["files"] + manifest["inputs"]:
    download(entry.get("url", manifest["base"] + entry["path"]), str(destination / entry["path"]), entry)
print(f"NODDI_DMIPY_REFERENCE={destination}")
