#!/usr/bin/env python3
"""Build a disconnectome web app display atlas: one TRX holding every bundle of a TRK
directory as a named group. Used for both shipped atlases.

The numbers the app reports come from the full-resolution TVX atlas, never from this file.
This is the picture only, so it is decimated hard: the undecimated atlas is 1.23 GB as TRK and
still 470 MB as float16, which no browser should download.

    python3 make_display_atlas.py ~/src/nii2tvx/hcp1065_avg_tracts_trk out/hcp1065_display.trx
    python3 make_display_atlas.py ~/src/ENIGMA_atlas/MNI152_1mm/Sparse/trk out/enigma_display.trx \
        --fraction 1.0 --floor 1 --spacing 3

ENIGMA ships its own Sparse set (226 of 7,461 streamlines per bundle), so that one is kept
whole and only thinned along its length; HCP1065 has no sparse copy and is decimated here.

Three levers, measured on the real atlas:
  * keep a fraction of the streamlines per bundle (20 % by default, with a floor so a small
    bundle does not thin out to a few wisps),
  * thin the points along each streamline to a target spacing (the atlas is sampled at
    0.51 mm, far finer than a 1 mm display needs),
  * store positions as float16 and DEFLATE the zip, which together are about 4.8x and cost
    nothing visible: float16 resolves 0.125 mm at 128 mm from the origin.

TRX stores positions in world RASmm, exactly as nibabel reports TRK streamlines, so no
transform is applied here. DIMENSIONS and VOXEL_TO_RASMM describe the MNI152 1 mm template the
app displays underneath, which is the same world space as the HCP1065 atlas with a wider
field of view.
"""
import argparse
import json
import pathlib
import sys
import zipfile

import nibabel as nib
import numpy as np

# The MNI152 1 mm brain the app shows as a backdrop, and the grid the TVX atlas is built on.
TEMPLATE_DIMENSIONS = [182, 218, 182]
TEMPLATE_VOXEL_TO_RASMM = [[-1.0, 0.0, 0.0, 90.0], [0.0, 1.0, 0.0, -126.0],
                           [0.0, 0.0, 1.0, -72.0], [0.0, 0.0, 0.0, 1.0]]


def thin(streamline, every):
    """Every nth point, always keeping the last so a bundle does not lose its endpoint."""
    kept = streamline[::every]
    if len(streamline) > 1 and not np.array_equal(kept[-1], streamline[-1]):
        kept = np.vstack([kept, streamline[-1]])
    return kept


def decimate(path, fraction, floor, spacing):
    """Read one TRK and return its kept streamlines in world RASmm."""
    tractogram = nib.streamlines.load(str(path), lazy_load=False)
    streamlines = tractogram.streamlines
    if len(streamlines) == 0:
        return []
    keep = min(len(streamlines), max(floor, int(round(len(streamlines) * fraction))))
    # Evenly spaced through the file rather than random: reproducible, and the bundles are
    # not ordered spatially, so this samples the whole bundle.
    chosen = np.linspace(0, len(streamlines) - 1, keep).astype(int)
    first = np.asarray(streamlines[chosen[0]])
    step = np.median(np.linalg.norm(np.diff(first, axis=0), axis=1)) if len(first) > 1 else spacing
    every = max(1, int(round(spacing / max(step, 1e-6))))
    kept = []
    for index in chosen:
        points = thin(np.asarray(streamlines[index], dtype=np.float32), every)
        if len(points) >= 2:
            kept.append(points)
    return kept


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('tracts', type=pathlib.Path, help='directory of .trk files, searched recursively')
    parser.add_argument('output', type=pathlib.Path, help='.trx to write')
    parser.add_argument('--fraction', type=float, default=0.2, help='streamlines kept per bundle (default 0.2)')
    parser.add_argument('--floor', type=int, default=150, help='minimum streamlines kept per bundle (default 150)')
    parser.add_argument('--spacing', type=float, default=2.0, help='target point spacing in mm (default 2)')
    args = parser.parse_args(argv)

    files = sorted(p for p in args.tracts.rglob('*.trk') if p.is_file())
    if not files:
        parser.error(f'no .trk files under {args.tracts}')

    positions, offsets, groups, report = [], [], {}, []
    total = 0
    vertices = 0  # running count: re-summing positions per streamline is quadratic
    for path in files:
        name = path.stem
        kept = decimate(path, args.fraction, args.floor, args.spacing)
        start = total
        for points in kept:
            offsets.append(vertices)
            positions.append(points)
            vertices += len(points)
            total += 1
        points_kept = sum(len(p) for p in kept)
        groups[name] = np.arange(start, total, dtype=np.uint32)
        report.append((name, len(kept), points_kept))
        print(f'  {name:<16} {len(kept):>6} streamlines {points_kept:>9} points', file=sys.stderr)

    stacked = np.concatenate(positions).astype(np.float16)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(args.output, 'w', zipfile.ZIP_DEFLATED) as archive:
        archive.writestr('header.json', json.dumps({
            'DIMENSIONS': TEMPLATE_DIMENSIONS,
            'VOXEL_TO_RASMM': TEMPLATE_VOXEL_TO_RASMM,
            'NB_VERTICES': int(len(stacked)),
            'NB_STREAMLINES': int(total),
        }))
        archive.writestr('positions.3.float16', stacked.tobytes())
        archive.writestr('offsets.uint64', np.asarray(offsets, dtype=np.uint64).tobytes())
        for name, indices in groups.items():
            archive.writestr(f'groups/{name}.uint32', indices.tobytes())

    size = args.output.stat().st_size
    print(f'{args.output}: {len(files)} bundles, {total} streamlines, {len(stacked)} points, '
          f'{size / 1e6:.1f} MB', file=sys.stderr)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
