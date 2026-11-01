import sys, numpy as np, nibabel as nib
src, out = sys.argv[1:3]
img = nib.load(src)
raw = np.asarray(img.dataobj.get_unscaled())
aff = img.affine
def save(name, arr, slope=None, inter=None):
    im = nib.Nifti1Image(arr, aff)
    if slope is not None:
        im.header.set_slope_inter(slope, inter)
    nib.save(im, f'{out}/{name}_T1w.nii.gz')
save('int16raw', raw.astype(np.int16))
save('uint8', np.clip(raw // 16, 0, 255).astype(np.uint8))
save('float32', (raw.astype(np.float32) * np.float32(0.37)) - np.float32(3.25))
save('int32', raw.astype(np.int32) * 3)
save('float64', raw.astype(np.float64) * 0.123456789)
