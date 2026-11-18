#!/usr/bin/env python3
"""Extract what MATLAB saved for the SamSrfAnalysis reverse-correlation hull runs.

For each host of the pinned recording (cli-reference.json) and each double RC
hull run, this writes MATLAB's pixel grid (`xc` and `yc` from the run's
regressor file, `reg_aps_bars.mat`, in MATLAB's pixel order), `Srf.Raw_Data`
(R^2, x0, y0, Fwhm and Beta at the profile peak) and `Srf.Data`, both over
`Srf.Roi`, as little-endian float64, with a manifest. cli_rc_hulls.rs rebuilds
the hulls from MATLAB's courses (extract_cli_courses.py) and compares.

Usage: extract_cli_rc_hulls.py CLI_ROOT OUTPUT_DIRECTORY
CLI_ROOT is the extracted recording: the AMD host at its root and the Intel host
under ubuntu-24.04/. Requires h5py and numpy.
"""
import json
from pathlib import Path
import sys

import h5py
import numpy

RUNS = ('rc_hull_lh_double', 'rc_custom_hrf_lh_double')
HOSTS = (('amd', Path('.')), ('intel', Path('ubuntu-24.04')))


def matrix(dataset):
    """A MATLAB matrix as rows x columns (HDF5 stores it transposed)."""
    values = numpy.array(dataset)
    if values.dtype.names:
        raise ValueError(f'{dataset.name}: complex data')
    return numpy.asarray(values, dtype='<f8').T


def labels(handle, srf):
    return [''.join(chr(c) for c in numpy.array(handle[ref]).ravel()) for ref in numpy.array(srf['Values']).ravel()]


def write(path, values):
    path.write_bytes(numpy.ascontiguousarray(values, dtype='<f8').tobytes())


def main(arguments):
    if len(arguments) != 2:
        raise SystemExit(__doc__)
    root, output = (Path(argument) for argument in arguments)
    output.mkdir(parents=True, exist_ok=False)
    manifest = {}
    for host, folder in HOSTS:
        (output / host).mkdir()
        runs = []
        for run in RUNS:
            directory = root / folder / 'source-1' / run
            maps = [p for p in sorted(directory.glob('*.mat')) if not p.name.startswith(('src_', 'reg_', 'hrf_'))]
            if len(maps) != 1:
                raise ValueError(f'{directory}: expected one map file, found {len(maps)}')
            with h5py.File(directory / 'reg_aps_bars.mat', 'r') as handle:
                xc = matrix(handle['xc'])
                yc = matrix(handle['yc'])
            with h5py.File(maps[0], 'r') as handle:
                srf = handle['Srf']
                data = matrix(srf['Data'])
                raw = matrix(srf['Raw_Data'])
                values = labels(handle, srf)
                roi = numpy.array(srf['Roi']).ravel().astype(int).tolist()
            if xc.shape != yc.shape or data.shape[1] != len(roi) or raw.shape != (5, len(roi)):
                raise ValueError(f'{run}: unexpected shapes {xc.shape} {yc.shape} {data.shape} {raw.shape}')
            # MATLAB's pixel order is column-major: xc(:) and yc(:).
            write(output / host / f'{run}.xc.f64', xc.ravel(order='F'))
            write(output / host / f'{run}.yc.f64', yc.ravel(order='F'))
            # Vertex by vertex: each vertex's rows contiguous.
            write(output / host / f'{run}.data.f64', data.T)
            write(output / host / f'{run}.raw.f64', raw.T)
            runs.append({'id': run, 'rows': xc.shape[0], 'columns': xc.shape[1], 'values': values, 'roi': roi})
        manifest[host] = runs
    (output / 'manifest.json').write_text(json.dumps(manifest, indent=1) + '\n')
    print(f'Wrote {sum(len(runs) for runs in manifest.values())} runs to {output}')


if __name__ == '__main__':
    main(sys.argv[1:])
