"""Browser-shaped FLAMeS pipeline in NumPy + ONNX Runtime, the reference packages/white-matter-lesions/src/pipeline.js is ported from.

    python reference.py <work> <name> --inputs <dir of skull-stripped FLAIR> [--folds 0] [--order nnunet|1|3] [--mirror]

Writes <work>/out/<name>/<case>.nii.gz. Models are <work>/flames_f<fold>.onnx. The knobs are the
deviations from nnUNetv2_predict under test: interpolation order, folds and mirroring.
"""
import argparse, glob, os, json, time
import numpy as np, nibabel as nib, onnxruntime as ort
from scipy import ndimage
from nnunetv2.preprocessing.resampling.default_resampling import resample_data_or_seg_to_shape

TARGET = np.array([1.0, 0.9, 0.9])  # network axis order (x, z, y) of the NIfTI voxel grid
PATCH = np.array([112, 128, 160])

def gaussian_map(patch):
    g = np.zeros(patch, np.float32)
    g[tuple(p // 2 for p in patch)] = 1
    g = ndimage.gaussian_filter(g, [p / 8 for p in patch], mode='constant', cval=0)
    g /= g.max()
    g[g == 0] = g[g > 0].min()
    return g

def starts(size, patch):
    if size <= patch:
        return [0]
    n = int(np.ceil((size - patch) / (patch * 0.5))) + 1
    step = (size - patch) / (n - 1)
    return [int(round(step * i)) for i in range(n)]

def resize(x, shape, order):
    return ndimage.zoom(x, np.array(shape) / np.array(x.shape), order=order, mode='nearest', grid_mode=True)

def segment(flair, spacing, sessions, order, mirror):
    nn = order == 'nnunet'
    nz = flair != 0
    nz = ndimage.binary_fill_holes(nz)
    idx = np.argwhere(nz)
    lo, hi = idx.min(0), idx.max(0) + 1
    crop = flair[tuple(slice(a, b) for a, b in zip(lo, hi))].astype(np.float64)
    mask = nz[tuple(slice(a, b) for a, b in zip(lo, hi))]
    crop = (crop - crop[mask].mean()) / max(crop[mask].std(), 1e-8)
    crop[~mask] = 0
    new_shape = np.round(np.array(crop.shape) * spacing / TARGET).astype(int)
    if nn:
        img = resample_data_or_seg_to_shape(crop[None], new_shape, spacing, TARGET, is_seg=False, order=3, order_z=0, force_separate_z=None)[0].astype(np.float32)
    else:
        img = resize(crop, new_shape, order).astype(np.float32)
    pad = np.maximum(PATCH - img.shape, 0)
    pads = [(p // 2, p - p // 2) for p in pad]
    img = np.pad(img, pads)
    g = gaussian_map(PATCH)
    acc = np.zeros((2,) + img.shape, np.float32)
    wsum = np.zeros(img.shape, np.float32)
    for z in starts(img.shape[0], PATCH[0]):
        for y in starts(img.shape[1], PATCH[1]):
            for x in starts(img.shape[2], PATCH[2]):
                sl = (slice(z, z + PATCH[0]), slice(y, y + PATCH[1]), slice(x, x + PATCH[2]))
                tile = img[sl][None, None]
                out = 0
                flips = [()] if not mirror else [(), (2,), (3,), (4,), (2, 3), (2, 4), (3, 4), (2, 3, 4)]
                for s in sessions:
                    for f in flips:
                        t = np.flip(tile, f) if f else tile
                        o = s.run(None, {'input': np.ascontiguousarray(t)})[0]
                        out = out + (np.flip(o, f) if f else o)
                out = out / (len(sessions) * len(flips))
                acc[(slice(None),) + sl] += out[0] * g
                wsum[sl] += g
    logits = acc / wsum
    logits = logits[(slice(None),) + tuple(slice(a, a + s) for (a, _), s in zip(pads, new_shape))]
    e = np.exp(logits - logits.max(0))
    prob = e[1] / e.sum(0)
    if nn:
        prob = resample_data_or_seg_to_shape(prob[None], crop.shape, TARGET, spacing, is_seg=False, order=1, order_z=0, force_separate_z=None)[0]
    else:
        prob = resize(prob, crop.shape, 1)
    seg = np.zeros(flair.shape, np.uint8)
    seg[tuple(slice(a, b) for a, b in zip(lo, hi))] = prob > 0.5
    return seg

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('work')
    ap.add_argument('name')
    ap.add_argument('--folds', default='0')
    ap.add_argument('--order', type=lambda v: v if v == 'nnunet' else int(v), default='nnunet')
    ap.add_argument('--mirror', action='store_true')
    ap.add_argument('--inputs', default='stripped')
    ap.add_argument('--model', default='flames_f{}.onnx')
    a = ap.parse_args()
    os.chdir(a.work)
    so = ort.SessionOptions()
    so.intra_op_num_threads = 8
    sessions = [ort.InferenceSession(a.model.format(f), so) for f in a.folds.split(',')]
    os.makedirs(f'out/{a.name}', exist_ok=True)
    # Existing masks are reused so an interrupted run can resume, but only under the same settings.
    config = {k: v for k, v in vars(a).items() if k not in ('work', 'name')}
    config_path = f'out/{a.name}.config.json'
    if os.path.exists(config_path) and json.load(open(config_path)) != config:
        raise SystemExit(f'out/{a.name} was produced with {json.load(open(config_path))}; choose another name')
    json.dump(config, open(config_path, 'w'))
    times = {}
    for f in sorted(glob.glob(f'{a.inputs}/*.nii.gz')):
        if f.endswith('_mask.nii.gz'):
            continue
        out = f'out/{a.name}/' + os.path.basename(f)
        if os.path.exists(out):
            continue
        img = nib.load(f)
        # nnU-Net reads (z, y, x) and applies the plans' transpose_forward [2, 0, 1]: (x, z, y).
        vol = np.asarray(img.dataobj, np.float32).transpose(0, 2, 1)
        spacing = np.array(img.header.get_zooms()[:3])[[0, 2, 1]]
        t = time.time()
        seg = segment(vol, spacing, sessions, a.order, a.mirror)
        times[os.path.basename(f)] = time.time() - t
        nib.save(nib.Nifti1Image(seg.transpose(0, 2, 1), img.affine), out)
        print(out, f'{times[os.path.basename(f)]:.1f}s', flush=True)
    json.dump(times, open(f'out/{a.name}.times.json', 'w'))

if __name__ == '__main__':
    main()
