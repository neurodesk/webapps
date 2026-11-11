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

from cli_plan import DATASETS, STAGED

NUMERIC = {'double', 'single', 'int8', 'uint8', 'int16', 'uint16', 'int32',
           'uint32', 'int64', 'uint64', 'logical'}
GIFTI_TYPES = {'NIFTI_TYPE_FLOAT32': '<f4', 'NIFTI_TYPE_FLOAT64': '<f8',
               'NIFTI_TYPE_INT32': '<i4', 'NIFTI_TYPE_UINT8': 'u1', 'NIFTI_TYPE_INT8': 'i1'}
IGNORED = set(STAGED)


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
        dimensions = tuple(int(element.attrib[f'Dim{axis}'])
                           for axis in range(int(element.attrib['Dimensionality'])))
        order = element.attrib['ArrayIndexingOrder']
        if order not in {'RowMajorOrder', 'ColumnMajorOrder'}:
            raise ValueError(f'Unsupported GIfTI indexing order {order} in {path}')
        if not dimensions or any(size < 0 for size in dimensions) or numpy.prod(dimensions) != values.size:
            raise ValueError(f'GIfTI dimensions do not match its payload in {path}')
        values = values.reshape(dimensions, order='C' if order == 'RowMajorOrder' else 'F')
        arrays.append((f'array{index}:{names.get("Name", "")}', f'gifti:{order}', values))
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
        if node.attrs.get('MATLAB_empty'):
            # v7.3 stores an empty array's MATLAB dimensions as its payload.
            # Preserve that vector and its class, rather than collapsing all
            # empty shapes into a single zero-length array.
            entries.append((name, f'empty:{kind}', numpy.asarray(node[()])))
        elif kind == 'cell' or node.dtype == h5py.ref_dtype:
            entries.append((name, 'cell-shape', numpy.asarray(node.shape, dtype='<u8')))
            for index, reference in enumerate(node[()].flat):
                visit(handle, handle[reference], f'{name}{{{index}}}')
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


def expected_results(run):
    """The supported CLI matrix's outputs, from the pinned SamSrf exporters.

    Derive this independently of either execution's files or Srf.Values: two
    executions dropping the same map must still fail the publication gate.
    """
    model = run['model']
    algorithm = run['algorithm']
    dataset = DATASETS[run['dataset']]
    stem = f'{dataset["hemisphere"]}_{model["Name"]}'
    noise_ceiling = dataset['runs'] > 1 and '-aver=1' in run['argv']
    if algorithm == 'prf':
        labels = ['R^2', *model['Param_Names']]
        if model.get('Compressive_Nonlinearity'):
            stem += '_Css'
            labels.append('Exponent')
        labels += ['Beta', 'Baseline']
        if noise_ceiling:
            labels[0] = 'nR^2'
            labels += ['Noise Ceiling', 'R^2']
    elif algorithm == 'rc':
        stem += '_Rcp'
        labels = (['R^2', 'x0', 'y0', 'Fwhm', 'Beta'] if model['Prf_Function'] == 0
                  else ['R^2', *model['Param_Names'], 'Beta', 'Baseline'])
        if noise_ceiling:
            labels.append('Noise Ceiling')
    elif algorithm == 'cf':
        labels = {
            0: ['R^2', 'x0', 'y0', 'Centre', 'Surround', 'Beta', 'Suppression', 'Fwhm', 'Vx'],
            -1: ['R^2', 'x0', 'y0', 'Sigma', 'Fwhm', 'Vx'],
            1: ['R^2', 'x0', 'y0', 'Sigma', 'Beta', 'Baseline', 'Fwhm', 'Vx'],
        }[model['Fit_pRF']]
        if noise_ceiling:
            labels.append('Noise Ceiling')
    else:
        raise ValueError(f'Unsupported CLI analysis {algorithm}')
    maps = [f'{stem}_{label.lower().replace(" ", "_")}.gii' for label in labels]
    return f'{stem}.mat', labels, maps


def require_results(run, root, names, report):
    mat, labels, maps = expected_results(run)
    missing = sorted(set([mat, *maps]) - set(names))
    if missing:
        report['failures'].append(f'{root}: missing scientific results: {missing}')
    if mat in names:
        entries = {key: (kind, values) for key, kind, values in read_mat(root / mat)}
        kind, data = entries.get('Srf.Data', (None, None))
        dtype = numpy.dtype('f4' if run['precision'] == 'single' else 'f8')
        valid_dtype = data is not None and (data.dtype == dtype or (
            data.dtype.names == ('real', 'imag')
            and all(data.dtype.fields[part][0] == dtype for part in ('real', 'imag'))))
        # HDF5 stores MATLAB's dimensions in reverse order.
        if (kind != run['precision'] or not valid_dtype or data.ndim != 2
                or data.shape[0] == 0 or data.shape[1] != len(labels)):
            report['failures'].append(f'{root / mat}: missing, empty or invalid Srf.Data for {run["precision"]} with {len(labels)} maps')
        actual_labels = []
        for index in range(len(labels)):
            kind, value = entries.get(f'Srf.Values{{{index}}}', (None, None))
            actual_labels.append(''.join(chr(int(v)) for v in value.flat)
                                 if kind == 'char' and value is not None else None)
        if actual_labels != labels:
            report['failures'].append(f'{root / mat}: Srf.Values differs from the case map contract')
        cell_kind, cell_shape = entries.get('Srf.Values', (None, None))
        if cell_kind != 'cell-shape' or numpy.prod(cell_shape) != len(labels):
            report['failures'].append(f'{root / mat}: Srf.Values has an invalid cell count')
    for name in maps:
        if name in names:
            arrays = read_gifti(root / name)
            if len(arrays) != 1 or not arrays[0][2].size:
                report['failures'].append(f'{root / name}: missing or empty exported map array')


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
    for root, files in zip((first, second), names):
        require_results(run, root / run['id'], files, report)
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
