#!/usr/bin/env python3
"""Hold the web engine's runs of the cli_plan.py matrix against one MATLAB execution.

WEB_ROOT is run_web_matrix.mjs output. CLI_ROOT is one MATLAB execution of the same
plan on the same bundle: a source MATLAB process (`source-1`) or, once it exists, the
compiled image (`compiled-1`). LABEL names which, and is copied into the report so a
source comparison cannot be presented as a compiled one.

For every run and every map in the run's contract (compare_cli.expected_results):

- Srf.Data: MATLAB's saved column over Srf.Roi, against the web value cast to the
  run's MATLAB class. The cast is checked to be exact: a single run's web value must
  already be a float32 value.
- GIfTI: the exported map over every vertex, both files, bitwise.

A map is `exact` when both are bitwise identical (nonfinite masks and the sign of
zero included) and `differs` otherwise, with the count of differing vertices (and of
those that differ only in the sign of zero), the largest absolute and
relative difference, the largest distance in units in the last place and whether the
nonfinite and zero masks agree. No tolerance is applied here: this report lists what
is exact and what is not. Existing per-map gates live with their owners (README).
A run the web engine refuses is `refused`, one whose input the web app's interface
cannot take `unsupported`, one that fails on either side `failed`; none counts as
agreement. A map missing on either side is an inventory error.

Usage: compare_web_cli.py PLAN_JSON WEB_ROOT CLI_ROOT LABEL REPORT_JSON
Requires numpy and h5py.
"""
import json
from pathlib import Path
import sys

import numpy

from compare_cli import expected_results, read_gifti, read_mat


def ulp_distance(a, b):
    """Largest distance in units in the last place between finite arrays of one float type."""
    if not a.size:
        return 0
    bits = {4: (numpy.int32, numpy.int64), 8: (numpy.int64, object)}[a.dtype.itemsize]
    def ordered(values):
        integers = values.view(bits[0]).astype(numpy.int64 if bits[1] is numpy.int64 else object)
        return numpy.where(integers < 0, -(integers & ~(1 << (8 * a.dtype.itemsize - 1))), integers)
    return int(numpy.max(numpy.abs(ordered(a) - ordered(b))))


def difference(matlab, web):
    """Bitwise comparison of two arrays of one dtype, with the measures listed in the module text."""
    if matlab.dtype != web.dtype or matlab.shape != web.shape:
        return {'exact': False, 'reason': f'{matlab.dtype}{matlab.shape} vs {web.dtype}{web.shape}'}
    exact = matlab.tobytes() == web.tobytes()
    result = {'exact': exact, 'count': int(matlab.size),
              'nonfinite': int(numpy.count_nonzero(~numpy.isfinite(matlab)))}
    if exact:
        return result
    finite_m = numpy.isfinite(matlab)
    finite_w = numpy.isfinite(web)
    both = finite_m & finite_w
    a = matlab[both]
    b = web[both]
    absolute = numpy.abs(a.astype(numpy.float64) - b.astype(numpy.float64))
    scale = numpy.maximum(numpy.abs(a.astype(numpy.float64)), numpy.finfo(matlab.dtype).tiny)
    bitwise = matlab.view(f'u{matlab.dtype.itemsize}') != web.view(f'u{web.dtype.itemsize}')
    nonfinite_equal = bool(numpy.array_equal(finite_m, finite_w)) and bool(
        numpy.all((matlab[~finite_m] == web[~finite_w]) | (numpy.isnan(matlab[~finite_m]) & numpy.isnan(web[~finite_w])))
        if numpy.array_equal(finite_m, finite_w) else False)
    result.update({
        'differing': int(numpy.count_nonzero(bitwise)),
        # +0 and -0 compare equal but are different bits; listed so they are not mistaken for agreement.
        'signedZeroOnly': int(numpy.count_nonzero(bitwise & (matlab == 0) & (web == 0))),
        'nonfiniteMaskEqual': nonfinite_equal,
        'zeroMaskEqual': bool(numpy.array_equal(matlab == 0, web == 0)),
        'maxAbsolute': float(absolute.max()) if absolute.size else 0.0,
        'maxRelative': float((absolute / scale).max()) if absolute.size else 0.0,
        'maxUlp': ulp_distance(a, b),
        'firstDiffering': int(numpy.flatnonzero(bitwise.ravel())[0]),
    })
    return result


def matlab_data(entries, precision):
    kind, data = entries['Srf.Data']
    dtype = numpy.dtype('<f4' if precision == 'single' else '<f8')
    imaginary = None
    if data.dtype.names == ('real', 'imag'):
        # MATLAB saved a complex Srf.Data. The web maps are real, so a nonzero
        # imaginary part is reported per map and makes that map differ.
        imaginary = numpy.ascontiguousarray(data['imag'])
        data = data['real']
    if kind != precision or data.dtype != dtype:
        raise ValueError(f'Srf.Data is {kind} {data.dtype}, expected {precision}')
    roi = entries['Srf.Roi'][1].ravel()
    if not numpy.all(roi == numpy.round(roi)) or roi.size != data.shape[0]:
        raise ValueError('Srf.Roi does not index the rows of Srf.Data')
    return numpy.ascontiguousarray(data), imaginary, roi.astype(numpy.int64) - 1


def compare_run(run, web_root, cli_root):
    report = {'id': run['id'], 'precision': run['precision'], 'algorithm': run['algorithm'],
              'maps': [], 'errors': []}
    web = json.loads((web_root / f'{run["id"]}.web.json').read_text())
    cli = json.loads((cli_root / 'receipts' / f'{run["id"]}.json').read_text())
    report['status'] = {'web': web['status'], 'matlab': cli['status']}
    if web['status'] in ('refused', 'unsupported'):
        # refused: the engine's public refusal; unsupported: the web app's
        # interface has no route for the run's input (run_browser_matrix.mjs).
        report['class'] = web['status']
        report['message'] = web.get('message', '')
        return report
    if web['status'] != 'succeeded' or cli['status'] != 'succeeded':
        report['class'] = 'failed'
        report['message'] = web.get('message') or cli.get('message')
        return report
    mat_name, labels, map_names = expected_results(run)
    if web['values'] != labels:
        report['errors'].append(f'web map labels {web["values"]} differ from the contract {labels}')
        report['class'] = 'inventory-error'
        return report
    directory = cli_root / run['id']
    missing = [name for name in [mat_name, *map_names] if not (directory / name).is_file()]
    missing += [f'web:{name}' for name in map_names if not (web_root / run['id'] / name).is_file()]
    if missing:
        report['errors'].append(f'missing results: {missing}')
        report['class'] = 'inventory-error'
        return report
    entries = {key: (kind, values) for key, kind, values in read_mat(directory / mat_name)}
    data, imaginary, roi = matlab_data(entries, run['precision'])
    report['matlabComplex'] = imaginary is not None
    vertices = web['vertices']
    maps = numpy.fromfile(web_root / run['id'] / 'maps.f64', dtype='<f8')
    if maps.size != len(labels) * vertices or data.shape[1] != len(labels) or roi.max() >= vertices:
        report['errors'].append(f'shape: web {maps.size} values for {len(labels)} maps x {vertices}; MATLAB {data.shape}')
        report['class'] = 'inventory-error'
        return report
    maps = maps.reshape(len(labels), vertices)
    for index, (label, name) in enumerate(zip(labels, map_names)):
        column = data[:, index]
        web_values = maps[index, roi]
        cast = web_values.astype(column.dtype)
        entry = {'label': label, 'file': name,
                 'castExact': bool(numpy.array_equal(cast.astype(numpy.float64), web_values, equal_nan=True))}
        entry['srfData'] = difference(column, cast)
        entry['imaginaryNonzero'] = 0 if imaginary is None else int(numpy.count_nonzero(imaginary[:, index]))
        if entry['imaginaryNonzero']:
            entry['maxImaginary'] = float(numpy.max(numpy.abs(imaginary[:, index])))
        matlab_gifti = read_gifti(directory / name)
        web_gifti = read_gifti(web_root / run['id'] / name)
        if len(matlab_gifti) != 1 or len(web_gifti) != 1:
            report['errors'].append(f'{name}: expected one GIfTI array on each side')
            entry['gifti'] = {'exact': False, 'reason': 'array count'}
        else:
            entry['gifti'] = difference(matlab_gifti[0][2], web_gifti[0][2])
        entry['class'] = 'exact' if entry['castExact'] and not entry['imaginaryNonzero'] and entry['srfData']['exact'] and entry['gifti']['exact'] else 'differs'
        report['maps'].append(entry)
    report['class'] = 'exact' if all(entry['class'] == 'exact' for entry in report['maps']) else 'differs'
    if report['errors']:
        report['class'] = 'inventory-error'
    return report


def compare(plan, web_root, cli_root, label):
    web_root = Path(web_root)
    cli_root = Path(cli_root)
    runs = [compare_run(run, web_root, cli_root) for run in plan['runs']]
    maps = [entry for run in runs for entry in run['maps']]
    count = lambda items, value: sum(item['class'] == value for item in items)
    return {
        'matlabExecution': label,
        'web': json.loads((web_root / 'environment.json').read_text()),
        'matlabEnvironmentRequest': json.loads((cli_root / 'environment-request.json').read_text())
        if (cli_root / 'environment-request.json').is_file() else None,
        'runs': runs,
        'summary': {
            'runs': len(runs),
            **{f'{value}Runs': count(runs, value) for value in ('exact', 'differs', 'refused', 'unsupported', 'failed', 'inventory-error')},
            'maps': len(maps),
            'exactMaps': count(maps, 'exact'),
            'differingMaps': count(maps, 'differs'),
        },
    }


def main(arguments):
    if len(arguments) != 5:
        raise SystemExit(__doc__)
    plan = json.loads(Path(arguments[0]).read_text())
    report = compare(plan, arguments[1], arguments[2], arguments[3])
    with Path(arguments[4]).open('x') as output:
        json.dump(report, output, indent=2)
        output.write('\n')
    for run in report['runs']:
        detail = run.get('message') or ', '.join(
            f'{entry["label"]}:{"=" if entry["class"] == "exact" else entry["srfData"].get("differing", "?")}'
            for entry in run['maps'])
        print(f'{run["class"]:<15} {run["id"]:<36} {detail}')
    print(json.dumps(report['summary']))
    if report['summary']['inventory-errorRuns'] or report['summary']['failedRuns']:
        raise SystemExit('Inventory errors or failed runs; see the report')


if __name__ == '__main__':
    main(sys.argv[1:])
