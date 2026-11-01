#!/usr/bin/env python3
"""Fetch the whole-head T1 and ICBM 2009c template pair for the issue #623 gate.

    python3 exes/greedy/scripts/fetch_t1_template.py DEST

reads the pins the BISON app already carries (apps/bison/examples.json for the
defaced T1, models/bison.manifest.json for the template and its mask) and the
two T1s pinned below (WHOLE_HEAD), checks
each download against its size and sha256, and decompresses the files
into DEST as the `.nii` names `cli/tests/workflows.rs` expects. Then run

    GREEDY_T1_TEMPLATE_DIR=DEST cargo test --release -p greedy-rs --test workflows \
      whole_head -- --ignored

Downloads are kept in DEST/.download, so a second run only re-checks. Needs
Python 3.9+ and no other dependency.
"""
import gzip
import hashlib
import json
import os
import shutil
import sys
import time
import urllib.request

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..'))
EXAMPLES = os.path.join(ROOT, 'apps', 'bison', 'examples.json')
MANIFEST = os.path.join(ROOT, 'models', 'bison.manifest.json')

T1 = 'sub-HML0541_ses-01_rec-defaced_T1w.nii.gz'
# OpenNeuro ds007522 (CC0), byte for byte: the identity start collapses the
# masked NMI affine on these two, and the unmasked start does not (#623).
WHOLE_HEAD = [
    {
        'url': 'https://huggingface.co/datasets/neurodeskorg/webapps/resolve/5002380600bb2bcd44c3db4fd5e4f3fcc40a7df3/greedy/whole-head/ds007522/sub-HML0689/ses-01/anat/sub-HML0689_ses-01_rec-defaced_T1w.nii.gz',
        'bytes': 10691252,
        'sha256': '4a3a463b20ddb906be0d3cd6ae5020fd7219759dc7d21c0bb7ae8fa1293946e3',
    },
    {
        'url': 'https://huggingface.co/datasets/neurodeskorg/webapps/resolve/5002380600bb2bcd44c3db4fd5e4f3fcc40a7df3/greedy/whole-head/ds007522/sub-HML0962/ses-01/anat/sub-HML0962_ses-01_rec-defaced_T1w.nii.gz',
        'bytes': 9195684,
        'sha256': '5e206aa8b6cdd29494cac3bfc901c7e5920849a865a79bc43546a89cc594535a',
    },
]
TEMPLATES = ['templates/mni_icbm152_t1_tal_nlin_sym_09c.nii.gz', 'templates/mni_icbm152_t1_tal_nlin_sym_09c_mask.nii.gz']


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for block in iter(lambda: f.read(1 << 22), b''):
            h.update(block)
    return h.hexdigest()


def verified(path, entry):
    return os.path.isfile(path) and os.path.getsize(path) == entry['bytes'] and sha256(path) == entry['sha256']


def download(entry, path):
    if verified(path, entry):
        return
    url = entry['url']
    os.makedirs(os.path.dirname(path), exist_ok=True)
    print(f'fetching {url}', flush=True)
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
        sys.exit(f'{url}: size or sha256 does not match its pin')


def pins():
    with open(EXAMPLES) as f:
        examples = json.load(f)
    t1 = [file for example in examples for file in example['files'] if file['name'] == T1]
    if not t1:
        sys.exit(f'{EXAMPLES}: no pin for {T1}')
    with open(MANIFEST) as f:
        manifest = json.load(f)
    entries = {entry['filename']: entry for group in manifest.values() if isinstance(group, list) for entry in group if isinstance(entry, dict) and 'filename' in entry}
    missing = [name for name in TEMPLATES if name not in entries]
    if missing:
        sys.exit(f'{MANIFEST}: no pin for {", ".join(missing)}')
    return [t1[0]] + [entries[name] for name in TEMPLATES] + WHOLE_HEAD


def main(dest):
    dest = os.path.abspath(dest)
    cache = os.path.join(dest, '.download')
    for entry in pins():
        name = os.path.basename(entry.get('name') or entry.get('filename') or entry['url'])
        archive = os.path.join(cache, name)
        download(entry, archive)
        out = os.path.join(dest, name[: -len('.gz')])
        with gzip.open(archive, 'rb') as src, open(out + '.part', 'wb') as f:
            shutil.copyfileobj(src, f, 1 << 22)
        os.replace(out + '.part', out)
        print(f'{out}: {os.path.getsize(out)} bytes', flush=True)


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
