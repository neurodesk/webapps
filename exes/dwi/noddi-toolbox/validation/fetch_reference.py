#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Download the pinned toolbox oracle, checking every cached or downloaded file.

Usage: python3 fetch_reference.py DEST
Prints NODDI_TOOLBOX_REFERENCE=DEST for a future reference test; no fit is run.
"""

import hashlib
import json
from pathlib import Path
import shutil
import sys
import tempfile
import urllib.request


def verified(path, entry):
    if not path.is_file() or path.stat().st_size != entry["bytes"]:
        return False
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest() == entry["sha256"]


def main():
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    destination = Path(sys.argv[1]).resolve()
    destination.mkdir(parents=True, exist_ok=True)
    manifest = json.loads(Path(__file__).with_name("reference.manifest.json").read_text())
    for entry in manifest["files"] + [manifest["wmSelection"]]:
        path = destination / entry["path"]
        if verified(path, entry):
            continue
        with tempfile.TemporaryDirectory(dir=destination, prefix=".download-") as temporary:
            partial = Path(temporary) / entry["path"]
            with urllib.request.urlopen(entry.get("url", manifest["base"] + entry["path"]), timeout=120) as response, partial.open("wb") as output:
                shutil.copyfileobj(response, output)
            if not verified(partial, entry):
                raise ValueError(f"Size or SHA-256 mismatch: {entry['path']}")
            partial.replace(path)
    print(f"NODDI_TOOLBOX_REFERENCE={destination}")


if __name__ == "__main__":
    main()
