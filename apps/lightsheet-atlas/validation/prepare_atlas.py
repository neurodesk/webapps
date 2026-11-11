"""Write the Allen CCFv3 50 um atlas files the app downloads, from the BrainGlobe atlas API.

    python prepare_atlas.py OUT_DIR   (BRAINGLOBE_DIR selects the atlas cache)

The template stays uint16. Allen structure ids reach 614454277, more than float32 holds exactly
(Greedy resamples in float32), so the annotation is written as uint16 indices into
structures.json; index 0 is outside the brain. Both volumes keep BrainGlobe's "asr" axis order
(anterior->posterior, superior->inferior, right->left) with the affine x = -k, y = -i, z = -j
(times 0.05 mm), so that NIfTI readers show anatomical RAS directions.
"""
import json, os, sys
from pathlib import Path
import numpy as np, nibabel as nib
from brainglobe_atlasapi import BrainGlobeAtlas
import brainglobe_atlasapi

out = Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True)
atlas = BrainGlobeAtlas('allen_mouse_50um', brainglobe_dir=Path(os.environ['BRAINGLOBE_DIR']), check_latest=False)
res = 0.05
affine = np.array([[0, 0, -res, 0], [-res, 0, 0, 0], [0, -res, 0, 0], [0, 0, 0, 1]], dtype=float)

def save(data, name, dtype):
    img = nib.Nifti1Image(np.asarray(data, dtype=dtype), affine)
    img.header.set_xyzt_units('mm')
    img.header.set_qform(affine, 1); img.header.set_sform(affine, 1)
    img.header['descrip'] = b'Allen CCFv3 2017 50um (BrainGlobe allen_mouse 3.1), asr'
    nib.save(img, out / name)

annotation = atlas.annotation
ids = np.unique(annotation)
ids = ids[ids != 0]
lookup = {int(v): i + 1 for i, v in enumerate(ids)}
index = np.zeros(annotation.shape, dtype=np.uint16)
for v, i in lookup.items():
    index[annotation == v] = i
save(atlas.reference, 'allen_mouse_50um_template.nii.gz', np.uint16)
save(index, 'allen_mouse_50um_annotation.nii.gz', np.uint16)

hemispheres = atlas.hemispheres
mid = hemispheres.shape[2] // 2
assert (hemispheres[:, :, :mid] == atlas.right_hemisphere_value).all()
assert (hemispheres[:, :, mid:] == atlas.left_hemisphere_value).all()

by_id = {s['id']: s for s in atlas.structures_list}
structures = []
for s in sorted(atlas.structures_list, key=lambda s: s['id']):
    structures.append({
        'id': int(s['id']), 'index': lookup.get(int(s['id']), 0), 'acronym': s['acronym'], 'name': s['name'],
        'rgb': [int(c) for c in s['rgb_triplet']], 'path': [int(p) for p in s['structure_id_path']],
    })
missing = [v for v in lookup if v not in by_id]
assert not missing, missing
json.dump({
    'atlas': 'allen_mouse_50um', 'version': atlas.metadata['version'], 'brainglobe_atlasapi': brainglobe_atlasapi.__version__,
    'orientation': atlas.orientation, 'shape': list(annotation.shape), 'resolution_um': 50,
    'right_hemisphere_axis2_below': int(mid),
    'citation': atlas.metadata['citation'], 'atlas_link': atlas.metadata['atlas_link'],
    'structures': structures,
}, open(out / 'allen_mouse_50um_structures.json', 'w'), separators=(',', ':'))
print(len(lookup), 'labelled structures of', len(structures), '; shape', annotation.shape)
