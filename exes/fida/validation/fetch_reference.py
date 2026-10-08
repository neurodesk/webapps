#!/usr/bin/env python3
"""Fetch the pinned FID-A reference data for the reference tests.

    python3 exes/fida/validation/fetch_reference.py DEST

reads reference.manifest.json beside this script and builds DEST in the
FIDA_TEST_DATA layout (README.md): the example inputs, FID-A's reader exports
(ref/, ref_vfix/), its processing exports (ops/), the Philips MEGA-PRESS
example (Philips-MEGA/) and the LCModel basis sets (basis/). Then run

    FIDA_TEST_DATA=DEST FIDA_EXAMPLES=DEST PHILIPS_MEGA=DEST/Philips-MEGA \
    LCMODEL_BASIS_DIR=DEST/basis FIDA_REQUIRE_REFERENCE=1 cargo test --release

Every download is checked against the manifest's sha256 and size, and so is
every file the script derives (the sequence-renamed and VD-layout twix
variants, made by twix_rename_seq.py and twix_vb_to_vd.py). Downloads are
kept in DEST/.download, so a second run only re-checks. Needs Python 3.9+,
tar and zstd.
"""
import gzip
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
MANIFEST = os.path.join(HERE, 'reference.manifest.json')


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for block in iter(lambda: f.read(1 << 22), b''):
            h.update(block)
    return h.hexdigest()


def verified(path, entry):
    return os.path.isfile(path) and os.path.getsize(path) == entry['bytes'] and sha256(path) == entry['sha256']


def download(url, path, entry):
    if verified(path, entry):
        return
    os.makedirs(os.path.dirname(path), exist_ok=True)
    for attempt in range(1, 6):
        try:
            with urllib.request.urlopen(url, timeout=120) as r, open(path + '.part', 'wb') as f:
                shutil.copyfileobj(r, f, 1 << 22)
            os.replace(path + '.part', path)
            break
        except OSError as e:
            if attempt == 5:
                raise
            print(f'  retrying ({e})', flush=True)
            time.sleep(5 * attempt)
    if not verified(path, entry):
        sys.exit(f'{url}: size or sha256 does not match the manifest')


def place(src, dest, rel):
    out = os.path.join(dest, rel)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    if os.path.lexists(out):
        os.remove(out)
    try:
        os.link(src, out)
    except OSError:
        shutil.copyfile(src, out)


def main(dest):
    m = json.load(open(MANIFEST))
    dest = os.path.abspath(dest)
    cache = os.path.join(dest, '.download')
    stamp = os.path.join(dest, '.manifest.sha256')
    want = sha256(MANIFEST)
    if os.path.isfile(stamp) and open(stamp).read().strip() == want:
        print(f'{dest} is up to date')
        return
    for e in m['files']:
        url = f"https://huggingface.co/datasets/{m['repository']}/resolve/{e['revision']}/{e['path']}"
        local = os.path.join(cache, e['revision'][:12], e['path'])
        print(f"{e['path']} ({e['bytes'] / 1e6:.1f} MB)", flush=True)
        download(url, local, e)
        if e.get('extract'):
            subprocess.run(['tar', '--use-compress-program', 'zstd -d --long=31', '-xf', local, '-C', dest], check=True)
        for rel in e.get('to', []):
            if e.get('gunzip'):
                os.makedirs(os.path.dirname(os.path.join(dest, rel)), exist_ok=True)
                with gzip.open(local) as g, open(os.path.join(dest, rel), 'wb') as f:
                    shutil.copyfileobj(g, f, 1 << 22)
            else:
                place(local, dest, rel)
    for d in m['derived']:  # in order: a VD variant is made from its VB variant
        out = os.path.join(dest, d['to'])
        if not verified(out, d):
            os.makedirs(os.path.dirname(out), exist_ok=True)
            src = os.path.join(dest, d['from'])
            subprocess.run([sys.executable, os.path.join(HERE, d['script']), src, out, *d.get('args', [])], check=True)
            if not verified(out, d):
                sys.exit(f"{d['to']}: {d['script']} did not reproduce the pinned sha256")
        print(f"{d['to']} (derived)", flush=True)
    for rel, src in m['copies'].items():
        place(os.path.join(dest, src), dest, rel)
    with open(stamp, 'w') as f:
        f.write(want + '\n')
    print(f'{dest}: {len(m["files"])} downloads, {len(m["derived"])} derived files, {len(m["copies"])} copies')


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
