# Float32 copies of an example with non-finite voxels inside the foreground:
# a NaN, +inf and -inf, to check matplotlib's handling in the port.
import sys, numpy as np, nibabel as nib
src, out = sys.argv[1:3]
img = nib.load(src)
data = np.asarray(img.dataobj, dtype=np.float32)
nx, ny, nz = data.shape
for name, value in [('nan', np.nan), ('posinf', np.inf), ('neginf', -np.inf)]:
    d = data.copy()
    d[nx // 2, ny // 2, nz // 2] = value
    d[nx // 2 + 3, ny // 2 - 5, nz // 2 + 7] = value
    nib.save(nib.Nifti1Image(d, img.affine), f'{out}/{name}_T1w.nii.gz')
