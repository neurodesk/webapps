"""Crop vendor inputs without resampling or changing their stored voxel values."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import nibabel as nib
import numpy as np

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--dir', type=Path, required=True)
parser.add_argument('--case', required=True)
parser.add_argument('--mask', type=Path, required=True)
args = parser.parse_args()
source = json.loads((Path(__file__).resolve().parents[2] / 'validation/dwi-vendors/sources.json').read_text())
entry = next(row for row in source['cases'] if row['id'] == args.case)
directory = args.dir / args.case
destination = directory / 'slab'
destination.mkdir(exist_ok=True)


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


for file in entry['files'].values():
    path = directory / file['name']
    assert path.stat().st_size == file['bytes'] and digest(path) == file['sha256']

image = nib.load(directory / entry['files']['image']['name'])
mask = nib.load(args.mask)
assert image.shape[:3] == mask.shape[:3] and np.allclose(image.affine, mask.affine)
sizes = [min(64, image.shape[0]), min(64, image.shape[1]), min(10, image.shape[2])]
starts = [(image.shape[i] - sizes[i]) // 2 for i in range(3)]
box = tuple(slice(start, start + size) for start, size in zip(starts, sizes))
offset = np.eye(4)
offset[:3, 3] = starts
affine = image.affine @ offset


def crop(source_image, path):
    raw = source_image.dataobj.get_unscaled()
    data = np.array(raw[box], order='F', copy=True)
    result = nib.Nifti1Image(data, affine, source_image.header.copy())
    result.set_qform(source_image.get_qform() @ offset, int(source_image.header['qform_code']))
    result.set_sform(source_image.get_sform() @ offset, int(source_image.header['sform_code']))
    result.header.set_slope_inter(source_image.dataobj.slope, source_image.dataobj.inter)
    nib.save(result, path)
    written = nib.load(path)
    assert np.array_equal(written.dataobj.get_unscaled(), data)
    assert written.dataobj.slope == source_image.dataobj.slope
    assert written.dataobj.inter == source_image.dataobj.inter
    assert np.allclose(written.affine, affine)
    assert np.allclose(written.get_qform(), source_image.get_qform() @ offset, rtol=0, atol=1e-4)
    assert np.allclose(written.get_sform(), source_image.get_sform() @ offset, rtol=0, atol=1e-4)
    return written


written = crop(image, destination / entry['files']['image']['name'])
assert written.shape[3:] == image.shape[3:]
mask_path = destination / args.mask.name
crop(mask, mask_path)
for role in ['bval', 'bvec']:
    file = entry['files'][role]
    shutil.copyfile(directory / file['name'], destination / file['name'])
    assert digest(destination / file['name']) == file['sha256']
sidecar = json.loads((directory / entry['files']['sidecar']['name']).read_text())
if 'SliceTiming' in sidecar:
    sidecar['SliceTiming'] = sidecar['SliceTiming'][box[2]]
sidecar['Sources'] = [entry['files']['image']['url']]
(destination / entry['files']['sidecar']['name']).write_text(json.dumps(sidecar, indent=2) + '\n')


def record(path):
    return {'name': path.name, 'bytes': path.stat().st_size, 'sha256': digest(path)}


manifest = {
    'id': f'{args.case}/slab',
    'files': {role: record(destination / file['name']) for role, file in entry['files'].items()},
    'mask': record(mask_path),
    'crop': {
        'source': entry,
        'sourceShape': list(image.shape),
        'startInclusive': starts,
        'stopExclusive': [start + size for start, size in zip(starts, sizes)],
        'shape': list(written.shape),
        'affine': affine.tolist(),
        'sclSlope': written.dataobj.slope,
        'sclInter': written.dataobj.inter,
        'maskSource': {'path': str(args.mask), 'sha256': digest(args.mask)},
        'nibabel': nib.__version__,
        'numpy': np.__version__,
    },
}
(destination / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(json.dumps(manifest['crop'], indent=2))
