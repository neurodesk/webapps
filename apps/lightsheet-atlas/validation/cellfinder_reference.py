"""Record cellfinder's classical candidate detection on a TIFF plane folder (reference for the JS port)."""
import json, sys, hashlib
from pathlib import Path
import numpy as np, tifffile, torch
from cellfinder.core.detect.detect import main as detect
from cellfinder.core.detect.filters.plane import TileProcessor
from cellfinder.core.detect.filters.setup_filters import DetectionSettings
import cellfinder

def run():
    folder, out = Path(sys.argv[1]), Path(sys.argv[2])
    voxel = tuple(float(v) for v in sys.argv[3:6]) if len(sys.argv) > 5 else (5.0, 2.0, 2.0)
    files = sorted(folder.glob('*.tif'))
    stack = np.stack([tifffile.imread(f) for f in files]).astype(np.uint16)
    cells = detect(signal_array=stack, voxel_sizes=voxel, n_free_cpus=2, torch_device='cpu', batch_size=1)
    # per-plane 2D stage: thresholded pixel count and bright-tile count
    s = DetectionSettings(plane_shape=stack.shape[1:], plane_original_np_dtype=stack.dtype, voxel_sizes=voxel)
    tp = TileProcessor(plane_shape=s.plane_shape, clipping_value=s.clipping_value, threshold_value=s.threshold_value,
        n_sds_above_mean_thresh=s.n_sds_above_mean_thresh, n_sds_above_mean_tiled_thresh=s.n_sds_above_mean_tiled_thresh,
        tiled_thresh_tile_size=None, log_sigma_size=s.log_sigma_size, soma_diameter=s.soma_diameter, torch_device='cpu', dtype='float32', use_scipy=True)
    planes = []
    for z in range(stack.shape[0]):
        t = torch.from_numpy(stack[z:z+1].astype(np.float32))
        f, m = tp.get_tile_mask(t)
        mask = (f[0].numpy() > 0)
        planes.append({'above': int(mask.sum()), 'brightTiles': int(m.sum()), 'aboveSha256': hashlib.sha256(np.packbits(mask).tobytes()).hexdigest()})
    rows = sorted([[int(c.x), int(c.y), int(c.z), int(c.type)] for c in cells])
    json.dump({'tool': f'cellfinder {cellfinder.__version__} cellfinder.core.detect.detect.main (torch_device=cpu, defaults)',
        'input': {'files': [f.name for f in files], 'shape': list(stack.shape), 'voxelSizesZYX': list(voxel)},
        'settings': {'somaDiameterPx': s.soma_diameter, 'ballXyPx': s.ball_xy_size, 'ballZPx': s.ball_z_size},
        'planes': planes, 'cells': rows}, open(out, 'w'), indent=1)
    print(len(rows), 'cells; types', {t: sum(1 for r in rows if r[3]==t) for t in set(r[3] for r in rows)})

if __name__ == '__main__':
    run()
