"""Reproduce the Marques brain example outside the source tree (requires nibabel)."""
import gzip
import hashlib
import json
import os
from pathlib import Path
import urllib.request

import nibabel as nib
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
SOURCE = 'https://raw.githubusercontent.com/JosePMarques/MP2RAGE-related-scripts/7a4ba42864c399354d21e84fc11e3d8911428871/'
CHECKSUMS = {
    'MP2RAGE_UNI.nii': '40b65d7bf05cca0527f8934e33525dc32ad6f9aef43d3bda72b903054a9479a1',
    'MP2RAGE_INV1.nii': '24000f6ae665e898837dff5d52557e63ee5143d498333fbab9fdbcc9cd907333',
    'MP2RAGE_INV2.nii': '8b2318ed8534b41ed4701ad349153456b1648ca59ea0b6f7452216a7b9fb2532',
    'Sa2RAGE_B1map.nii.gz': '106db9fe67604236bd68d3fa1b008aa2373604b77b738daf56f6e86c3eaf74e4',
}
source = Path(os.environ['TMPDIR']) / 'mp2rage-real-source'
output = Path(os.environ['TMPDIR']) / 'mp2rage-brain-example'
source.mkdir(parents=True, exist_ok=True)
output.mkdir(parents=True, exist_ok=True)
for name, checksum in CHECKSUMS.items():
    path = source / name
    if not path.exists():
        urllib.request.urlretrieve(SOURCE + 'data/' + name, path)
    data = path.read_bytes()
    assert hashlib.sha256(data).hexdigest() == checksum, name
    if name.startswith('MP2RAGE'):
        (output / (name + '.gz')).write_bytes(gzip.compress(data, mtime=0))

b1 = nib.load(source / 'Sa2RAGE_B1map.nii.gz')
uni = nib.load(source / 'MP2RAGE_UNI.nii')
assert b1.shape == uni.shape == (218, 220, 143)
assert np.allclose(b1.affine, uni.affine, atol=1e-4)
relative = np.asarray(b1.get_fdata() / 1000, dtype=np.float32)
header = b1.header.copy()
header.set_data_dtype(np.float32)
image = nib.Nifti1Image(relative, b1.affine, header)
image.header.set_slope_inter(1, 0)
(output / 'B1_relative.nii.gz').write_bytes(gzip.compress(image.to_bytes(), mtime=0))
for name in ['License.txt', 'DemoForR1Correction.m']:
    urllib.request.urlretrieve(SOURCE + name, output / name)
(output / 'provenance.json').write_text((ROOT / 'example-provenance.json').read_text())
for path in output.glob('*.nii.gz'):
    print(path.name, path.stat().st_size, hashlib.sha256(path.read_bytes()).hexdigest())
print(output)
