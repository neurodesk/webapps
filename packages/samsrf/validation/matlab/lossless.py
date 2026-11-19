#!/usr/bin/env python3
"""Hold one lossless export of @neurodesk/samsrf (the app's or the `samsrf` command line's
<prefix>_lossless.bin) against the engine harness and a MATLAB execution of the same plan run.

    lossless.py PLAN BUNDLE_SHA256 RUN_ID LOSSLESS_FILE MATLAB_ROOT REPORT
        --expect source|compiled-runtime --engine-root WEB_ROOT [--allow-unattested-source-inputs]

The file layout is packages/samsrf/README.md's "Lossless export"; read_lossless reads it here
independently of the package's reader, and refuses any other layout. compare_ui_cli.py reads the
lossless file of each UI download with the same functions.

The comparison is refused (exit 2) unless the plan, bundle manifest and MATLAB receipts pass
compare_web_cli.py's checks, WEB_ROOT is the engine harness's run of the same plan, RUN_ID is a run
MATLAB and the engine both completed, and the file's header names the run's maps, precision and
arithmetic reference, MATLAB's vertex count and Srf.Roi as its analysed vertices.

Engine equality is the gate (exit 1 when it fails): the file's float64 rows equal the engine's
maps.f64, and its imaginary parts (+0 when absent) equal maps.imag.f64 (+0 when absent), byte for
byte, with the same presence of imaginary parts. Each map's float64 values over Srf.Roi are then
compared with MATLAB's Srf.Data column bitwise, as compare_web_cli.py compares the engine's rows:
cast to MATLAB's class (the cast must be exact), real and imaginary parts apart. MATLAB differences
are reported, never gated, and no tolerance is applied. Srf.Raw_Data (`raw` rows) is not compared.
"""

import argparse
import json
from pathlib import Path
import struct
import sys

import numpy

import cli_plan
from compare_cli import expected_results, read_mat
from compare_web_cli import (Inventory, matlab_execution, matlab_results, sha256_bytes, srf_data_entry,
                             validate_plan, web_execution, web_files)

MAGIC = b'SAMSRFLX'
FORMAT = 'samsrf-lossless-maps'
VERSION = 1
PREAMBLE = 16


def lossless_name(stem):
    """The lossless file beside the map set `stem` (losslessName in packages/samsrf/src/lossless.js)."""
    return f'{stem}_lossless.bin'


def write_lossless(real, values, precision, reference, imaginary=None, raw_values=(), raw=None, analysed=None):
    """The bytes writeLossless writes for these arrays (rows x vertices). The tests write fixtures with it
    and hold it to the package's writer."""
    real = numpy.ascontiguousarray(real, '<f8')
    header = json.dumps({'format': FORMAT, 'version': VERSION, 'precision': precision,
                         'arithmeticReference': reference, 'vertices': real.shape[1], 'values': list(values),
                         'imaginary': imaginary is not None, 'raw': list(raw_values),
                         'analysed': None if analysed is None else len(analysed)},
                        separators=(',', ':'), ensure_ascii=False).encode()
    header += b' ' * ((8 - (PREAMBLE + len(header)) % 8) % 8)
    sections = [real, imaginary, raw if len(raw_values) else None]
    payload = b''.join(numpy.ascontiguousarray(section, '<f8').tobytes() for section in sections if section is not None)
    if analysed is not None:
        payload += numpy.asarray(analysed, '<u4').tobytes()
    return MAGIC + struct.pack('<II', VERSION, len(header)) + header + payload


def read_lossless(data):
    """The header and arrays of a lossless file: `real` and `imaginary` (None when absent) are
    rows x vertices float64, `raw` raw rows x vertices, `analysed` int64 (None for every vertex)."""
    if len(data) < PREAMBLE or data[:8] != MAGIC:
        raise Inventory('not a SamSrf lossless file')
    version, length = struct.unpack_from('<II', data, 8)
    if version != VERSION:
        raise Inventory(f'unsupported lossless version {version}')
    if (PREAMBLE + length) % 8 or PREAMBLE + length > len(data):
        raise Inventory('the lossless header length is invalid')
    try:
        header = json.loads(data[PREAMBLE:PREAMBLE + length].decode('utf-8'))
    except ValueError as error:
        raise Inventory(f'the lossless header is not JSON ({error})') from error
    names = lambda value: isinstance(value, list) and all(isinstance(item, str) for item in value)
    count = lambda value: type(value) is int and value >= 0
    if (not isinstance(header, dict) or header.get('format') != FORMAT or header.get('version') != VERSION
            or header.get('precision') not in cli_plan.PRECISIONS or not isinstance(header.get('arithmeticReference'), str)
            or not count(header.get('vertices')) or header['vertices'] < 1 or not names(header.get('values'))
            or not isinstance(header.get('imaginary'), bool) or not names(header.get('raw'))
            or not (header.get('analysed') is None or count(header['analysed']))):
        raise Inventory('the lossless header does not describe a SamSrf map set')
    vertices, rows, raw_rows = header['vertices'], len(header['values']), len(header['raw'])
    sizes = [8 * rows * vertices, 8 * rows * vertices if header['imaginary'] else 0, 8 * raw_rows * vertices,
             4 * (header['analysed'] or 0)]
    if PREAMBLE + length + sum(sizes) != len(data):
        raise Inventory('the lossless file length does not match its header')
    offset = PREAMBLE + length
    arrays = []
    for size, dtype in zip(sizes, ('<f8', '<f8', '<f8', '<u4')):
        arrays.append(numpy.frombuffer(data, dtype=dtype, count=size // numpy.dtype(dtype).itemsize, offset=offset))
        offset += size
    real, imaginary, raw, analysed = arrays
    return {'precision': header['precision'], 'arithmeticReference': header['arithmeticReference'],
            'vertices': vertices, 'values': header['values'], 'rawValues': header['raw'],
            'real': real.reshape(rows, vertices),
            'imaginary': imaginary.reshape(rows, vertices) if header['imaginary'] else None,
            'raw': raw.reshape(raw_rows, vertices),
            'analysed': None if header['analysed'] is None else analysed.astype(numpy.int64)}


def check_header(lossless, run, labels, roi, vertices, reference):
    """The file must describe this run's MATLAB result: its maps, precision, reference, surface and ROI."""
    if lossless['values'] != labels:
        raise Inventory(f'lossless map labels {lossless["values"]} differ from the contract {labels}')
    if lossless['precision'] != run['precision']:
        raise Inventory(f'the lossless file holds {lossless["precision"]} results, the run is {run["precision"]}')
    if lossless['arithmeticReference'] != reference:
        raise Inventory(f'the lossless file names arithmetic reference {lossless["arithmeticReference"]}, expected {reference}')
    if lossless['vertices'] != vertices:
        raise Inventory(f'the lossless file covers {lossless["vertices"]} vertices, MATLAB {vertices}')
    analysed = numpy.arange(vertices) if lossless['analysed'] is None else lossless['analysed']
    if not numpy.array_equal(numpy.sort(analysed), numpy.sort(roi)):
        raise Inventory('the lossless analysed vertices differ from MATLAB Srf.Roi')


def engine_agreement(lossless, engine_real, engine_imaginary, engine_complex):
    """The file's rows and imaginary parts against the engine harness's maps.f64 and maps.imag.f64."""
    zeros = numpy.zeros_like(lossless['real'])
    imaginary = zeros if lossless['imaginary'] is None else lossless['imaginary']
    result = {'real': lossless['real'].shape == engine_real.shape and lossless['real'].tobytes() == engine_real.tobytes(),
              'imaginary': imaginary.shape == engine_imaginary.shape and imaginary.tobytes() == engine_imaginary.tobytes(),
              'complex': (lossless['imaginary'] is not None) == engine_complex}
    result['equal'] = all(result.values())
    return result


def matlab_maps(lossless, labels, data, imaginary, roi):
    """Each map's float64 values and imaginary parts over Srf.Roi against MATLAB's Srf.Data."""
    parts = numpy.zeros_like(lossless['real']) if lossless['imaginary'] is None else lossless['imaginary']
    entries = []
    for index, label in enumerate(labels):
        entry = {'label': label, **srf_data_entry(data[:, index], None if imaginary is None else imaginary[:, index],
                                                   lossless['real'][index, roi], parts[index, roi])}
        entry['exact'] = entry['castExact'] and entry['srfData']['exact'] and entry['imaginary']['exact']
        entries.append(entry)
    return entries


def compare(plan, plan_sha, manifest, manifest_sha, run_id, data, matlab_root, engine_root, expect, allow_unattested=False):
    matlab_root, engine_root = Path(matlab_root), Path(engine_root)
    validate_plan(plan, manifest)
    runs = {run['id']: run for run in plan['runs']}
    if run_id not in runs:
        raise Inventory(f'{run_id} is not a plan run')
    run = runs[run_id]
    identity, receipts = matlab_execution(matlab_root, plan, manifest, allow_unattested)
    if identity['kind'] != expect:
        raise Inventory(f'expected a {expect} execution, the receipts record {identity["kind"]}')
    environment, records = web_execution(engine_root, plan, plan_sha, manifest_sha)
    engine = records[run_id]
    if receipts[run_id]['status'] != 'succeeded' or engine['status'] != 'succeeded':
        raise Inventory(f'{run_id}: MATLAB {receipts[run_id]["status"]}, engine {engine["status"]}; nothing to compare')
    mat, labels, _ = expected_results(run)
    entries = {key: (kind, values) for key, kind, values in read_mat(matlab_root / run_id / mat)}
    matlab_data, matlab_imaginary, roi, vertices = matlab_results(entries, run['precision'], labels)
    lossless = read_lossless(data)
    check_header(lossless, run, labels, roi, vertices, run['model'].get('Arithmetic_Reference', 'current'))
    _, _, engine_real, engine_imaginary = web_files(run, engine, engine_root / run_id)
    maps = matlab_maps(lossless, labels, matlab_data, matlab_imaginary, roi)
    return {
        'plan': {'sha256': plan_sha, 'runs': len(plan['runs'])},
        'bundleManifestSha256': manifest_sha,
        'matlab': identity,
        'engine': environment,
        'run': run_id,
        'losslessSha256': sha256_bytes(data),
        'engineAgreement': engine_agreement(lossless, engine_real, engine_imaginary, engine.get('imaginarySha256') is not None),
        'maps': maps,
        'summary': {'maps': len(maps), 'exactMaps': sum(entry['exact'] for entry in maps),
                    'rawRowsNotCompared': lossless['rawValues']},
    }


def main(arguments=None):
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    for name in ('plan', 'manifest', 'run_id', 'lossless', 'matlab_root', 'report'):
        parser.add_argument(name)
    parser.add_argument('--expect', required=True, choices=['source', 'compiled-runtime'])
    parser.add_argument('--engine-root', required=True)
    parser.add_argument('--allow-unattested-source-inputs', action='store_true')
    args = parser.parse_args(arguments)
    plan_bytes = Path(args.plan).read_bytes()
    manifest_bytes = Path(args.manifest).read_bytes()
    report_path = Path(args.report)
    try:
        if report_path.exists():
            raise Inventory(f'{report_path} already exists')
        plan = json.loads(plan_bytes)
        if plan != cli_plan.plan():
            raise Inventory("the plan is not cli_plan.py's matrix")
        report = compare(plan, sha256_bytes(plan_bytes), json.loads(manifest_bytes), sha256_bytes(manifest_bytes),
                         args.run_id, Path(args.lossless).read_bytes(), args.matlab_root, args.engine_root, args.expect,
                         args.allow_unattested_source_inputs)
    except Inventory as error:
        print(f'refused: {error}', file=sys.stderr)
        return 2
    with report_path.open('x') as output:
        json.dump(report, output, indent=2)
        output.write('\n')
    mark = lambda d: 'exact' if d['exact'] else str(d['differing'])
    for entry in report['maps']:
        print(f'{entry["label"]}: real={mark(entry["srfData"])} imaginary={mark(entry["imaginary"])} '
              f'castExact={entry["castExact"]} imaginaryNonzero={entry["imaginaryNonzero"]}')
    print(json.dumps({**report['summary'], 'engineAgreement': report['engineAgreement']}))
    if not report['engineAgreement']['equal']:
        print('failed: the lossless file is not the engine harness result', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
