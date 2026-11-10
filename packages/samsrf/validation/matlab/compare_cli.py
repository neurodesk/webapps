#!/usr/bin/env python3
"""Compare two executions of the cli_plan.py matrix (for example, source and compiled).

The gate is exact. Each run must succeed in both executions with the same output
files. Every numerical array in the exported GIfTIs and in the saved MAT files
(v7.3, HDF5) must be bitwise identical, which also makes the nonfinite and
zero masks identical. The saved maps must have the run's precision. Text
fields can name the results directory, which differs between executions, so
they are reported but not gated. Function handles and MATLAB's object
subsystem are counted as not compared.

Usage: compare_cli.py PLAN_JSON FIRST_ROOT SECOND_ROOT REPORT_JSON
Requires h5py for the MAT files.
"""
import base64
import json
from pathlib import Path
import sys
import xml.etree.ElementTree as ElementTree
import zlib

import numpy

NUMERIC = {'double', 'single', 'int8', 'uint8', 'int16', 'uint16', 'int32',
           'uint32', 'int64', 'uint64', 'logical'}
GIFTI_TYPES = {'NIFTI_TYPE_FLOAT32': '<f4', 'NIFTI_TYPE_FLOAT64': '<f8',
               'NIFTI_TYPE_INT32': '<i4', 'NIFTI_TYPE_UINT8': 'u1', 'NIFTI_TYPE_INT8': 'i1'}
IGNORED = {'SamSrf_defaults.json'}


def read_gifti(path):
    arrays = []
    for index, element in enumerate(ElementTree.parse(path).getroot().iter('DataArray')):
        kind = numpy.dtype(GIFTI_TYPES[element.get('DataType')])
        if element.get('Endian') == 'BigEndian':
            kind = kind.newbyteorder('>')
        text = element.findtext('Data', '').strip()
        encoding = element.get('Encoding')
        if encoding == 'ASCII':
            values = numpy.array(text.split(), dtype=kind)
        else:
            raw = base64.b64decode(text)
            if encoding == 'GZipBase64Binary':
                raw = zlib.decompress(raw, 15 + 32)
            elif encoding != 'Base64Binary':
                raise ValueError(f'Unsupported GIfTI encoding {encoding} in {path}')
            values = numpy.frombuffer(raw, dtype=kind)
        names = {item.findtext('Name'): item.findtext('Value')
                 for item in element.iter('MD')}
        arrays.append((f'array{index}:{names.get("Name", "")}', 'gifti', values))
    return arrays


def read_mat(path):
    import h5py

    entries = []

    def text(value):
        return value.decode() if isinstance(value, bytes) else str(value)

    def visit(handle, node, name):
        kind = text(node.attrs.get('MATLAB_class', b''))
        if isinstance(node, h5py.Group):
            if kind and kind not in {'struct'}:
                entries.append((name, kind, None))
                return
            for key in sorted(node):
                visit(handle, node[key], f'{name}.{key}' if name else key)
            return
        if kind == 'cell' or node.dtype == h5py.ref_dtype:
            for index, reference in enumerate(node[()].flat):
                visit(handle, handle[reference], f'{name}{{{index}}}')
            return
        if node.attrs.get('MATLAB_empty'):
            entries.append((name, kind, numpy.zeros(0)))
        elif kind in NUMERIC:
            entries.append((name, kind, numpy.asarray(node[()])))
        elif kind == 'char':
            entries.append((name, 'char', numpy.asarray(node[()])))
        else:
            entries.append((name, kind or 'unknown', None))

    with h5py.File(path, 'r') as handle:
        for key in sorted(handle):
            if not key.startswith('#'):
                visit(handle, handle[key], key)
    return entries


def compare_values(first, second):
    if first.dtype != second.dtype or first.shape != second.shape:
        return {'equal': False, 'reason': f'{first.dtype}{first.shape} vs {second.dtype}{second.shape}'}
    equal = first.tobytes() == second.tobytes()
    result = {'equal': equal}
    if not equal and first.dtype.kind in 'fiub':
        a = first.astype(numpy.float64)
        b = second.astype(numpy.float64)
        result['nonfiniteMaskEqual'] = bool(numpy.array_equal(~numpy.isfinite(a), ~numpy.isfinite(b)))
        finite = numpy.isfinite(a) & numpy.isfinite(b)
        if finite.any():
            result['maxAbsoluteDifference'] = float(numpy.max(numpy.abs(a[finite] - b[finite])))
        result['differingValues'] = int(numpy.count_nonzero(a.view(numpy.uint64) != b.view(numpy.uint64))) \
            if a.size else 0
    return result


def outputs(directory):
    return sorted(path.name for path in Path(directory).iterdir()
                  if path.is_file() and path.name not in IGNORED)


def compare_run(run, first, second):
    report = {'id': run['id'], 'failures': [], 'text': [], 'notCompared': [], 'arrays': 0}
    statuses = [json.loads((root / 'receipts' / f'{run["id"]}.json').read_text())['status']
                for root in (first, second)]
    report['status'] = statuses
    if statuses[0] != statuses[1]:
        report['failures'].append(f'Status differs: {statuses}')
        return report
    if statuses[0] != 'succeeded':
        # The matrix holds supported cases only, so a shared failure is not a pass.
        report['failures'].append('Run failed in both executions')
        return report
    names = [outputs(root / run['id']) for root in (first, second)]
    report['files'] = names[0]
    if names[0] != names[1]:
        report['failures'].append(f'Output files differ: {names}')
        return report
    if not any(name.endswith('.mat') for name in names[0]):
        report['failures'].append('No saved MAT result')
    for name in names[0]:
        if name.endswith('.gii'):
            reader = read_gifti
        elif name.endswith('.mat'):
            reader = read_mat
        else:
            if (first / run['id'] / name).read_bytes() != (second / run['id'] / name).read_bytes():
                report['text'].append(name)
            continue
        a = reader(first / run['id'] / name)
        b = reader(second / run['id'] / name)
        if [entry[:2] for entry in a] != [entry[:2] for entry in b]:
            report['failures'].append(f'{name}: different array inventory')
            continue
        for (key, kind, x), (_, _, y) in zip(a, b):
            label = f'{name}:{key}'
            if x is None:
                report['notCompared'].append(f'{label} ({kind})')
                continue
            result = compare_values(x, y)
            if kind == 'char':
                if not result['equal']:
                    report['text'].append(label)
                continue
            report['arrays'] += 1
            if not result['equal']:
                report['failures'].append({'array': label, **result})
            if name.endswith('.mat') and key == 'Srf.Data' and kind != run['precision']:
                report['failures'].append(f'{label} is {kind}, expected {run["precision"]}')
    if not report['arrays']:
        report['failures'].append('No numerical arrays were compared')
    return report


def compare(plan, first, second):
    runs = [compare_run(run, Path(first), Path(second)) for run in plan['runs']]
    return {'gate': 'bitwise-identical numerical outputs and identical run status',
            'runs': runs,
            'succeeded': sum(run['status'] == ['succeeded', 'succeeded'] for run in runs),
            'failedInBoth': sum(run['status'][0] == run['status'][1] == 'failed' for run in runs),
            'exact': not any(run['failures'] for run in runs)}


def main(arguments):
    if len(arguments) != 4:
        raise SystemExit(__doc__)
    plan = json.loads(Path(arguments[0]).read_text())
    report = compare(plan, arguments[1], arguments[2])
    with Path(arguments[3]).open('x') as output:
        json.dump(report, output, indent=2)
        output.write('\n')
    print(f'{report["succeeded"]} runs succeeded in both executions, '
          f'{report["failedInBoth"]} failed in both; exact: {report["exact"]}')
    if not report['exact']:
        raise SystemExit('Executions differ; see the report')


if __name__ == '__main__':
    main(sys.argv[1:])
