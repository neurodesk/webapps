#!/usr/bin/env python3
"""Extract MATLAB's preprocessed courses from the pinned SamSrfAnalysis recording.

The CLI recording (cli-reference.json) saves each run's Srf in a MAT file (v7.3,
HDF5). Srf.Y holds the courses over Srf.Roi after samsrf_gii2srf's detrend,
z-score and run combination (and, for connective fields, the global regression
and smoothing the model asks for). This writes, per host and run, Srf.Y as
little-endian float64, vertex by vertex, and a manifest with each host's CPU and
BLAS line, so cli_preprocess.rs can compare the port without reading HDF5.

Usage: extract_cli_courses.py CLI_ROOT OUTPUT_DIRECTORY
CLI_ROOT is the extracted recording: the AMD host at its root and the Intel
host under ubuntu-24.04/, as its README says. Requires h5py and numpy.
"""
import json
from pathlib import Path
import re
import sys

import h5py
import numpy


def host_receipt(source):
    environment = json.loads((source / 'receipts' / 'environment.json').read_text())
    text = json.dumps(environment)
    cpu = re.search(r'Model name:\s+([^\\]+)', text)
    blas = re.search(r'CNR branch ([A-Za-z0-9_]+)', text)
    if not cpu or not blas:
        raise ValueError(f'{source}: no CPU model or MKL branch in the receipt')
    return {'cpu': cpu.group(1).strip(), 'cnr': blas.group(1)}


def courses(directory, run_id):
    found = []
    for path in sorted(directory.glob('*.mat')):
        if path.name.startswith(('src_', 'reg_', 'hrf_')):
            continue
        with h5py.File(path, 'r') as handle:
            if 'Srf' in handle and 'Y' in handle['Srf']:
                srf = handle['Srf']
                found.append((path.name, numpy.array(srf['Y']), numpy.array(srf['Roi']).ravel()))
    if len(found) != 1:
        raise ValueError(f'{run_id}: expected one saved Srf with Y, found {[name for name, _, _ in found]}')
    return found[0]


def main(arguments):
    if len(arguments) != 2:
        raise SystemExit(__doc__)
    root, output = (Path(argument) for argument in arguments)
    if output.exists() and any(output.iterdir()):
        raise SystemExit(f'{output}: use a new or empty directory')
    plan = json.loads((root / 'plan.json').read_text())
    ids = [run['id'] for run in plan['runs']]
    if not ids or len(ids) != len(set(ids)):
        raise ValueError('the plan must contain nonempty, unique run identities')
    manifest = {'plan': plan, 'hosts': {}}
    for key, source in (('amd', root / 'source-1'), ('intel', root / 'ubuntu-24.04' / 'source-1')):
        missing = [run_id for run_id in ids if not (source / run_id).is_dir()]
        if missing:
            raise ValueError(f'{source}: missing planned run directories {missing}')
        receipt = host_receipt(source)
        expected = 'AMD' if key == 'amd' else 'INTEL'
        if not receipt['cpu'].upper().startswith(expected):
            raise ValueError(f'{source}: CPU {receipt["cpu"]} is not {expected}')
        (output / key).mkdir(parents=True)
        runs = []
        for run in plan['runs']:
            directory = source / run['id']
            name, values, roi = courses(directory, run['id'])
            kind = {'<f8': 'double', '<f4': 'single'}[values.dtype.str]
            if kind != run['precision']:
                raise ValueError(f'{run["id"]}: Srf.Y is {kind}, the run is {run["precision"]}')
            if values.ndim != 2 or values.shape[0] != roi.size:
                raise ValueError(f'{run["id"]}: Srf.Y {values.shape} does not cover Srf.Roi ({roi.size})')
            file = f'{run["id"]}.Y.f64'
            numpy.ascontiguousarray(values, dtype='<f8').tofile(output / key / file)
            if not numpy.all(numpy.isfinite(roi) & (roi >= 1) & (roi == numpy.floor(roi))) or numpy.unique(roi).size != roi.size:
                raise ValueError(f'{run["id"]}: Srf.Roi is not distinct whole vertex numbers')
            runs.append({'id': run['id'], 'mat': name, 'precision': kind, 'vertices': int(values.shape[0]),
                         'volumes': int(values.shape[1]), 'roi': [int(vertex) for vertex in roi], 'file': file})
        manifest['hosts'][key] = {**receipt, 'runs': runs}
    (output / 'manifest.json').write_text(json.dumps(manifest, indent=1) + '\n')
    print(f'{sum(len(host["runs"]) for host in manifest["hosts"].values())} courses written to {output}')


if __name__ == '__main__':
    main(sys.argv[1:])
