#!/usr/bin/env python3
"""Pack a FIDA_TEST_DATA tree for Hugging Face and update reference.manifest.json.

    python3 exes/fida/validation/pack_reference.py DATA OUT

DATA holds only the files the tests read (README.md, "References in CI").
Files the manifest already obtains otherwise (Hugging Face examples, basis
sets, derived twix variants) are left out; every other file goes into one of
OUT/{inputs,ref,ops}.tar.zst, except exact duplicates, which become manifest
`copies`. The archive entries get revision "PENDING": upload OUT with

    hf upload neurodeskorg/webapps OUT lcmodel/fida-reference --repo-type dataset

and set "revision" of those entries to the commit it prints.
"""
import hashlib
import io
import json
import os
import subprocess
import sys
import tarfile

HERE = os.path.dirname(os.path.abspath(__file__))
MANIFEST = os.path.join(HERE, 'reference.manifest.json')
PREFIX = 'lcmodel/fida-reference/'
GROUPS = {'ref': 'ref', 'ref_vfix': 'ref', 'ops': 'ops'}


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for block in iter(lambda: f.read(1 << 22), b''):
            h.update(block)
    return h.hexdigest()


def main(data, out):
    m = json.load(open(MANIFEST))
    m['files'] = [e for e in m['files'] if not e['path'].startswith(PREFIX)]
    provided = {rel for e in m['files'] for rel in e.get('to', [])} | {d['to'] for d in m['derived']}
    rels = sorted(
        os.path.relpath(os.path.join(r, f), data)
        for r, ds, fs in os.walk(data)
        for f in fs
        if not f.startswith('.') and '.download' not in r
    )
    first = {}
    copies = {}
    groups = {}
    for rel in rels:
        h = sha256(os.path.join(data, rel))
        if rel in provided:
            first.setdefault(h, rel)
            continue
        if h in first:
            copies[rel] = first[h]
            continue
        first[h] = rel
        groups.setdefault(GROUPS.get(rel.split('/')[0], 'inputs'), []).append(rel)
    os.makedirs(out, exist_ok=True)
    for name, members in sorted(groups.items()):
        path = os.path.join(out, f'{name}.tar.zst')
        # A reproducible tar: sorted members, no owner or time stamps.
        z = subprocess.Popen(['zstd', '-q', '-19', '--long=31', '-T0', '-f', '-o', path], stdin=subprocess.PIPE)
        with tarfile.open(fileobj=z.stdin, mode='w|', format=tarfile.PAX_FORMAT) as tar:
            for rel in members:
                ti = tar.gettarinfo(os.path.join(data, rel), arcname=rel)
                ti.uid = ti.gid = 0
                ti.uname = ti.gname = ''
                ti.mtime = 0
                ti.mode = 0o644
                with open(os.path.join(data, rel), 'rb') as f:
                    tar.addfile(ti, f)
        z.stdin.close()
        if z.wait():
            sys.exit(f'zstd failed for {path}')
        raw = sum(os.path.getsize(os.path.join(data, r)) for r in members)
        size = os.path.getsize(path)
        print(f'{name}.tar.zst: {len(members)} files, {raw / 1e6:.1f} MB -> {size / 1e6:.1f} MB')
        m['files'].append({'path': PREFIX + f'{name}.tar.zst', 'revision': 'PENDING', 'bytes': size, 'sha256': sha256(path), 'extract': True})
    m['copies'] = dict(sorted(copies.items()))
    with open(MANIFEST, 'w') as f:
        json.dump(m, f, indent=2)
        f.write('\n')
    print(f'{len(copies)} duplicates recorded as copies; manifest updated')


if __name__ == '__main__':
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(*sys.argv[1:3])
