#!/usr/bin/env python3
"""Download and verify MuscleMap's pinned upstream parity inputs and references."""

import argparse
import hashlib
import json
from pathlib import Path
import urllib.request


MANIFEST = Path(__file__).parents[1] / "model-sources" / "parity-reference.json"


def verified(path, entry):
    if not path.is_file() or path.stat().st_size != entry["bytes"]:
        return False
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while block := stream.read(1024 * 1024):
            digest.update(block)
    return digest.hexdigest() == entry["sha256"]


def fetch(destination, manifest, case_ids=None):
    required = None
    if case_ids:
        cases = {case["id"]: case for case in manifest["cases"]}
        unknown = set(case_ids) - cases.keys()
        if unknown:
            raise ValueError(f"Unknown parity cases: {', '.join(sorted(unknown))}")
        required = {cases[name][kind] for name in case_ids for kind in ("input", "reference")}

    for entry in manifest["files"]:
        if required is not None and entry["path"] not in required:
            continue
        path = destination / entry["path"]
        if not verified(path, entry):
            path.parent.mkdir(parents=True, exist_ok=True)
            temporary = path.with_name(path.name + ".part")
            url = (
                f"https://huggingface.co/datasets/{manifest['repository']}/resolve/"
                f"{manifest['revision']}/{manifest['prefix']}/{entry['path']}"
            )
            try:
                with urllib.request.urlopen(url, timeout=120) as response, temporary.open("wb") as output:
                    while block := response.read(1024 * 1024):
                        output.write(block)
                if not verified(temporary, entry):
                    raise ValueError(f"Size or SHA-256 mismatch for {entry['path']}")
                temporary.replace(path)
            finally:
                temporary.unlink(missing_ok=True)
        print(f"Verified {entry['path']}", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("destination", type=Path)
    parser.add_argument("--case", action="append", dest="case_ids")
    parser.add_argument("--manifest", type=Path, default=MANIFEST)
    args = parser.parse_args()
    fetch(args.destination.resolve(), json.loads(args.manifest.read_text()), args.case_ids)


if __name__ == "__main__":
    main()
