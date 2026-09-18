#!/usr/bin/env python3
"""Extract the OSF brain example without changing image bytes or sidecars."""
import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path
import urllib.request
import zipfile

SOURCE = 'https://osf.io/download/ubf3m/?version=2'
SHA256 = '1576e55ba8628255d2d7372f5023265e934d3c74011718e858761e7d6f494e55'
SUBJECT = 'sub-170705134431std1312211075243167001'

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--archive', type=Path)
args = parser.parse_args()
scratch = Path(os.environ['TMPDIR']) / 'qsmbly-real-brain'
scratch.mkdir(parents=True, exist_ok=True)
archive = args.archive or scratch / '01_bids.zip'
if not archive.exists():
    urllib.request.urlretrieve(SOURCE, archive)
if hashlib.sha256(archive.read_bytes()).hexdigest() != SHA256:
    raise ValueError('OSF archive checksum mismatch')
target = scratch / 'publish'
target.mkdir(exist_ok=True)
files = []
with zipfile.ZipFile(archive) as source:
    for part in ['mag', 'phase']:
        for extension in ['nii', 'json']:
            name = f'{SUBJECT}_ses-1_run-1_part-{part}_T2starw.{extension}'
            member = f'01_bids/{SUBJECT}/ses-1/anat/{name}'
            data = source.read(member)
            original_sha = hashlib.sha256(data).hexdigest()
            if extension == 'nii':
                data = gzip.compress(data, mtime=0)
                name += '.gz'
            (target / name).write_bytes(data)
            files.append({
                'name': name,
                'role': 'metadata' if extension == 'json' else ('magnitude' if part == 'mag' else 'phase'),
                'sha256': hashlib.sha256(data).hexdigest(),
                'bytes': len(data),
                'archiveMember': member,
                'originalSha256': original_sha,
            })
provenance = {
    'project': 'https://osf.io/ru43c/',
    'source': SOURCE,
    'archiveSha256': SHA256,
    'authors': ['Steffen Bollmann', 'Ashley Stewart'],
    'license': None,
    'licenseNote': 'The upstream OSF project does not declare a data license.',
    'processing': 'Lossless gzip compression only. Original NIfTI bytes and JSON sidecars preserved.',
    'acquisition': {'fieldStrengthTesla': 3, 'echoTimeSeconds': 0.02, 'echoCount': 1},
    'files': files,
}
(target / 'provenance.json').write_text(json.dumps(provenance, indent=2) + '\n')
(target / 'README.md').write_text('''# QSMbly real brain example

Magnitude and phase MRI from [Bollmann and Stewart's QSMxT test data](https://osf.io/ru43c/),
OSF `01_bids.zip`, version 2, first subject, session 1, run 1.
Acquired on a Siemens Prisma fit at 3 T with 1 mm isotropic voxels and a single
20 ms echo. The matched images are 224 × 224 × 160 voxels.

Select this example in QSMbly, generate a brain mask, then reconstruct and
download a susceptibility map. This single-echo acquisition does not support
multi-echo T2*/R2* fitting. Phase retains the original Siemens integer scaling;
QSMbly scales it to radians during processing.

NIfTI files are losslessly gzip-compressed; image headers, voxels, geometry,
and acquisition JSON sidecars are unchanged. See `provenance.json` for archive
and file checksums. The upstream OSF project declares no data license; this
mirror does not assign one.

Citation: Stewart AW, Robinson SD, O'Brien K, et al. QSMxT: Robust masking and
artifact reduction for quantitative susceptibility mapping. Magnetic Resonance
in Medicine. 2022;87(3):1289–1300. https://doi.org/10.1002/mrm.29048
''')
print(f'Prepared {len(files)} files ({sum(f["bytes"] for f in files):,} bytes) at {target}')
