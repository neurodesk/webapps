#!/usr/bin/env python3
"""Download the immutable, checksummed MATLAB reference into an empty directory."""
from pathlib import Path
import hashlib
import io
import json
import sys
import urllib.request
import zipfile

if len(sys.argv) != 2:
    raise SystemExit('Usage: python download.py OUTPUT_DIRECTORY')
destination = Path(sys.argv[1])
if destination.exists() and any(destination.iterdir()):
    raise SystemExit(f'{destination}: use a new or empty directory')
pin = json.loads(Path(__file__).with_name('fixture.json').read_text())
with urllib.request.urlopen(pin['url'], timeout=120) as response:
    data = response.read()
if len(data) != pin['bytes'] or hashlib.sha256(data).hexdigest() != pin['sha256']:
    raise SystemExit('MATLAB reference archive does not match its checksum and size')
with zipfile.ZipFile(io.BytesIO(data)) as archive:
    archive.extractall(destination)
print(f'Verified and extracted MATLAB reference: {destination}')
