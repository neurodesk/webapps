"""Optional QC montage."""
from __future__ import annotations
import os
import numpy as np


def make_qc(uni, t1u, t1c, b1_sa, b1_tfl, mask, path):
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt

    os.makedirs(os.path.dirname(path), exist_ok=True)
    sx, sy, sz = [s // 2 for s in uni.shape[:3]]

    def show(a, img, sl, axis, cmap, lo, hi, title, cbar=False, m=None):
        s = img[sl, :, :] if axis == 0 else img[:, sl, :] if axis == 1 else img[:, :, sl]
        s = np.rot90(s)
        if m is not None:
            mm = m[sl, :, :] if axis == 0 else m[:, sl, :] if axis == 1 else m[:, :, sl]
            s = np.where(np.rot90(mm), s, np.nan)
        im = a.imshow(s, cmap=cmap, vmin=lo, vmax=hi, interpolation='nearest')
        a.set_title(title, fontsize=9); a.axis('off')
        if cbar:
            plt.colorbar(im, ax=a, fraction=0.046, pad=0.02)

    ncol = 4 if b1_tfl is None else 5
    fig, axg = plt.subplots(3, ncol, figsize=(3.4 * ncol, 10))
    for r, (axis, sl) in enumerate([(0, sx), (1, sy), (2, sz)]):
        show(axg[r, 0], uni, sl, axis, 'gray', 0, 4095, 'UNI' if r == 0 else '')
        show(axg[r, 1], t1u, sl, axis, 'viridis', 500, 2600,
             'T1 uncorrected (ms)' if r == 0 else '', cbar=True, m=mask)
        show(axg[r, 2], t1c, sl, axis, 'viridis', 500, 2600,
             'T1 B1-corrected (ms)' if r == 0 else '', cbar=True, m=mask)
        show(axg[r, 3], b1_sa, sl, axis, 'RdBu_r', 0.5, 1.3,
             'B1 (rel.)' if r == 0 else '', cbar=True, m=mask)
        if b1_tfl is not None:
            show(axg[r, 4], b1_tfl, sl, axis, 'RdBu_r', 0.5, 1.3,
                 'B1 tfl (cross-check)' if r == 0 else '', cbar=True, m=mask)
    plt.tight_layout()
    plt.savefig(path, dpi=110, bbox_inches='tight')
    plt.close(fig)
