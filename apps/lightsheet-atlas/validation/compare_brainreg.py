"""Compare the app's registration of the example brain with brainreg's.

    python compare_brainreg.py APP_OUT BRAINREG_OUT STRUCTURES_JSON
APP_OUT is validation/run-example.mjs's output folder; BRAINREG_OUT is brainreg's output for
    brainreg brain/ BRAINREG_OUT -v 50 40 40 --orientation psl --atlas allen_mouse_50um
on the example's planes (BrainGlobe test data brainreg/brainreg-test-data.zip::input/brain).
Prints Dice per major division, the distance between the two sample->atlas maps inside the brain,
and each division's volume in the sample (mm^3) from both registrations, as JSON.
"""
import json, sys
import numpy as np, tifffile
out, ref_dir, structures_json = sys.argv[1:4]
shape = json.load(open(f'{out}/meta.json'))['shape']
nifti_order = lambda a: a.reshape(shape[::-1]).transpose(2, 1, 0)  # file order (r, s, a) -> [a][s][r]
labels = nifti_order(np.fromfile(f'{out}/labels.u16', dtype=np.uint16))
table = json.load(open(structures_json))
index_to_id = np.zeros(max(s['index'] for s in table['structures']) + 1, dtype=np.int64)
paths = {}
for s in table['structures']:
    if s['index']:
        index_to_id[s['index']] = s['id']
    paths[s['id']] = s['path']
ours = index_to_id[labels]
ref = tifffile.imread(f'{ref_dir}/registered_atlas.tiff').astype(np.int64)
assert ref.shape == ours.shape, (ref.shape, ours.shape)
DIVISIONS = {'Isocortex': 315, 'OLF': 698, 'HPF': 1089, 'CTXsp': 703, 'STR': 477, 'PAL': 803, 'TH': 549, 'HY': 1097,
             'MB': 313, 'P': 771, 'MY': 354, 'CB': 512, 'fiber tracts': 1009, 'VS': 73, 'root': 997}
voxel_mm3 = 0.05 ** 3
def member(volume, sid):
    ids = [int(i) for i in np.unique(volume) if i and sid in paths.get(int(i), [])]
    return np.isin(volume, ids)
dice, volumes = {}, {}
for name, sid in DIVISIONS.items():
    a, b = member(ours, sid), member(ref, sid)
    dice[name] = round(float(2 * (a & b).sum() / (a.sum() + b.sum())), 4)
    volumes[name] = {'app_mm3': round(float(a.sum() * voxel_mm3), 3), 'brainreg_mm3': round(float(b.sum() * voxel_mm3), 3)}
inside = ref > 0
d2 = 0
for axis in range(3):
    mine = nifti_order(np.fromfile(f'{out}/coord{axis}.f32', dtype=np.float32)) * 50.0
    theirs = tifffile.imread(f'{ref_dir}/deformation_field_{axis}.tiff') * 1000.0
    d2 = d2 + (mine - theirs) ** 2
distance = np.sqrt(d2)[inside]
print(json.dumps({
    'dice': dice,
    'atlasCoordinateDistanceUm': {'median': round(float(np.median(distance)), 1), 'p90': round(float(np.percentile(distance, 90)), 1)},
    'divisionVolumes': volumes,
}, indent=1))
