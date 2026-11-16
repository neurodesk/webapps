#!/usr/bin/env python3
"""Download the first two pinned X001 runs (apps/samsrf/examples.json) into a new
directory, checking each file's SHA-256 and size.

Usage: fetch_x001_runs.py OUTPUT_DIRECTORY
"""
import hashlib
import json
import pathlib
import sys
import urllib.request

EXAMPLES = pathlib.Path(__file__).resolve().parents[4] / 'apps' / 'samsrf' / 'examples.json'
RUNS = ('lh_uBars1.gii', 'lh_uBars2.gii')


def main(target):
    target.mkdir()
    files = {item['name']: item for item in json.loads(EXAMPLES.read_text())[0]['files']}
    for name in RUNS:
        pin = files[name]
        with urllib.request.urlopen(pin['url'], timeout=300) as response:
            data = response.read()
        if hashlib.sha256(data).hexdigest() != pin['sha256'] or len(data) != pin['bytes']:
            raise SystemExit(f'{name} does not match its pin')
        (target / name).write_bytes(data)
        print(name, pin['sha256'])


if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    main(pathlib.Path(sys.argv[1]))
