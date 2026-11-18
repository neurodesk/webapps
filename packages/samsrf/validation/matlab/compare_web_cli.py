#!/usr/bin/env python3
"""Hold the web engine's runs of the cli_plan.py matrix against one MATLAB execution.

WEB_ROOT is run_web_matrix.mjs or run_browser_matrix.mjs output. MATLAB_ROOT is one
MATLAB execution of the same plan: a source MATLAB process (run_source_cli.m) or the
compiled image (run_runtime_cli.py). Which one it is comes from its own receipts, never
from the caller: `--expect` must agree with them, so a source execution cannot be
reported as the compiled image.

Provenance checks, before any value is read:

- The plan is non-empty with unique run identities, and every run's model is the
  model file of the bundle manifest (the bytes cli_plan.py writes).
- The web execution names the SHA-256 of this plan file and of this bundle manifest.
- Every MATLAB receipt belongs to a plan run, ran that run's argv and records its
  execution kind. A compiled execution must name its image ID (sha256:...), and its
  receipts/inputs.json must equal the bundle manifest. Source receipts do not record
  the bundle; a source comparison then needs --allow-unattested-source-inputs, and the
  report says "unattested".

Each run is classed:

- `exact` / `differs`: both executions succeeded. Every contract map
  (compare_cli.expected_results) is compared bitwise twice: MATLAB's Srf.Data column
  over Srf.Roi against the web value cast to MATLAB's class (the cast must be exact),
  and the exported GIfTIs over every vertex. Where Srf.Data is complex, its imaginary
  parts are compared bitwise with the engine's (maps.imag.f64, cast the same way); a
  web run without that file has +0 imaginary parts. A map is exact only if all three
  agree bit for bit, nonfinite values and the sign of zero included. Differences
  report the vertices that differ, those that differ only in the sign of zero, the
  largest absolute, relative and ULP differences (+0 and -0 are the same ordinal;
  signedZeroOnly counts them), and whether the masks agree.
- `refused`: MATLAB succeeded and the engine refused a run it is expected to refuse
  (single RC with a fitted profile, single CF Gaussian) with exactly the core's text.
- `unsupported`: MATLAB succeeded and the browser runner could not offer the run's
  input (a subject-HRF file): the record carries exactly the core's subject-HRF text.
- `failed`: anything else: MATLAB failed, the web failed, the web status is not the
  expected one, or an expected refusal carries other text (a crash, for example; the
  run then names `expectedMessage`). Both sides' statuses are kept.
- `inventory-error`: missing, extra, empty, truncated or inconsistent files: a GIfTI
  that does not cover every vertex, an ROI that is not unique integers in 1..vertices,
  maps.f64 or maps.imag.f64 of the wrong length or hash, labels or ROI that differ
  between the executions.

Web-only files (the polar angle and eccentricity GIfTIs, which SamSrfAnalysis does
not export) are checked for shape and listed as not compared. MATLAB-only files
(src_*.mat, reg_*.mat and the staged inputs) are listed as not compared.
No tolerance is applied. Any failed or inventory-error run exits nonzero.

Usage: compare_web_cli.py PLAN_JSON BUNDLE_SHA256_JSON WEB_ROOT MATLAB_ROOT REPORT_JSON
           --expect source|compiled-runtime [--allow-unattested-source-inputs]
Requires numpy and h5py.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re

import numpy

import cli_plan
from compare_cli import expected_results, read_gifti, read_mat

SOURCE_MODE = 'source-samsrfanalysis-cli'
RECEIPT_EXECUTION = {'source': 'source', 'compiled-runtime': 'compiled-runtime'}
IMAGE_ID = re.compile(r'^sha256:[0-9a-f]{64}$')
SHA256 = re.compile(r'^[0-9a-f]{64}$')
MATLAB_EXTRA = re.compile(r'^(SamSrf_defaults\.json|hrf_custom\.mat|src_.+\.mat|reg_.+\.mat)$')
WEB_STATUSES = {'succeeded', 'refused', 'unsupported', 'failed'}


class Inventory(ValueError):
    """The artifacts are incomplete or inconsistent; nothing about the values is claimed."""


def sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()


def is_sha256(value):
    """A lowercase hex SHA-256 and nothing else (re.match's $ would also accept a trailing newline)."""
    return isinstance(value, str) and SHA256.fullmatch(value) is not None


def read_json(path):
    try:
        return json.loads(Path(path).read_text())
    except FileNotFoundError:
        raise Inventory(f'missing {path}') from None


def model_bytes(model):
    """cli_plan.write_models's bytes for one model file."""
    return (json.dumps(model, indent=2, allow_nan=False) + '\n').encode()


def validate_plan(plan, manifest):
    runs = plan.get('runs')
    if not isinstance(runs, list) or not runs:
        raise Inventory('the plan has no runs')
    ids = [run.get('id') for run in runs]
    if len(set(ids)) != len(ids):
        raise Inventory('the plan repeats run identities')
    for run in runs:
        if run['precision'] not in cli_plan.PRECISIONS or run['id'] != f'{run["case"]}_{run["precision"]}':
            raise Inventory(f'{run["id"]}: run identity does not match its case and precision')
        if run['model'].get('Name') != run['id']:
            raise Inventory(f'{run["id"]}: model Name differs from the run identity')
        if manifest.get(f'models/{run["id"]}.json') != sha256_bytes(model_bytes(run['model'])):
            raise Inventory(f'{run["id"]}: the plan model is not the bundle manifest model file')


def expected_web_outcome(run, runner):
    """What the engine must do with a plan run on this runner, with the exact text of an
    expected refusal; run_web_matrix.mjs's expectedEngineOutcome says the same."""
    model = run['model']
    single = run['precision'] == 'single'
    # exes/samsrf/core/src/model.rs: Error::NotImplemented.
    if single and run['algorithm'] == 'rc' and model.get('Prf_Function', 0) != 0:
        return {'status': 'refused',
                'message': 'Data_Precision=single with a Prf_Function fit is not supported by this port'}
    if single and run['algorithm'] == 'cf' and model.get('Fit_pRF') == 1:
        return {'status': 'refused', 'message': 'Data_Precision=single with Fit_pRF=1 is not supported by this port'}
    hrf = model.get('Hrf')
    if runner == 'browser' and isinstance(hrf, str) and hrf.startswith('hrf_'):
        # exes/samsrf/core/src/hrf.rs resolve(): nothing in the browser loads the subject-HRF file.
        return {'status': 'unsupported', 'message': f'model: Hrf {hrf} is an old-school HRF fit file: '
                                                    'the caller must load its fP and call hrf::old_school'}
    return {'status': 'succeeded'}


def normalised_argv(argv):
    return [f'-outpath={cli_plan.RESULTS}' if value.startswith('-outpath=') else value for value in argv]


def cpu_model(text):
    match = re.search(r'Model name:\s*(.+)', text or '')
    return match.group(1).strip() if match else None


def matlab_execution(root, plan, manifest, allow_unattested):
    """The MATLAB execution's identity from its receipts, and its per-run receipts."""
    receipts = root / 'receipts'
    environment = read_json(receipts / 'environment.json')
    if environment.get('execution') == 'compiled-runtime':
        kind = 'compiled-runtime'
        image = environment.get('image') or {}
        if not IMAGE_ID.fullmatch(str(image.get('id', ''))):
            raise Inventory('the compiled receipts do not name an image ID')
        identity = {'kind': kind, 'image': image,
                    'cpu': cpu_model((environment.get('host') or {}).get('lscpu')),
                    'requested': environment.get('requested')}
    elif environment.get('executionMode') == SOURCE_MODE:
        kind = 'source'
        identity = {'kind': kind, 'matlab': environment.get('matlab'),
                    'toolboxes': environment.get('toolboxes'),
                    'cpu': cpu_model(environment.get('cpu')),
                    'blas': (environment.get('observed') or {}).get('blas'),
                    'requested': environment.get('requested')}
    else:
        raise Inventory('the MATLAB receipts name neither a source nor a compiled execution')
    inputs = receipts / 'inputs.json'
    if inputs.is_file():
        recorded = read_json(inputs)
        if recorded.get('sha256') != manifest or recorded.get('unchanged') is not True:
            raise Inventory('the MATLAB execution ran on other inputs than the bundle manifest')
        identity['inputs'] = 'attested by receipts/inputs.json'
    elif kind == 'compiled-runtime':
        raise Inventory('the compiled receipts have no inputs.json')
    elif allow_unattested:
        identity['inputs'] = 'unattested: source receipts do not record the bundle'
    else:
        raise Inventory('source receipts do not record the bundle; pass --allow-unattested-source-inputs')
    expected_names = {f'{run["id"]}.json' for run in plan['runs']}
    names = {path.name for path in receipts.iterdir() if path.suffix == '.json'} - {'environment.json', 'inputs.json'}
    if names != expected_names:
        raise Inventory(f'MATLAB receipts do not match the plan runs: {sorted(names ^ expected_names)}')
    records = {}
    for run in plan['runs']:
        receipt = read_json(receipts / f'{run["id"]}.json')
        if receipt.get('id') != run['id'] or receipt.get('execution') != RECEIPT_EXECUTION[kind]:
            raise Inventory(f'{run["id"]}: receipt identity or execution kind differs')
        if normalised_argv(receipt.get('argv', [])) != run['argv']:
            raise Inventory(f'{run["id"]}: the MATLAB receipt ran another argv than the plan')
        if receipt.get('status') not in ('succeeded', 'failed'):
            raise Inventory(f'{run["id"]}: unknown MATLAB status {receipt.get("status")}')
        records[run['id']] = receipt
    return identity, records


def web_execution(root, plan, plan_sha, manifest_sha):
    environment = read_json(root / 'environment.json')
    if environment.get('runner') not in ('node', 'browser'):
        raise Inventory('the web environment names no runner')
    if environment.get('planSha256') != plan_sha:
        raise Inventory('the web execution ran another plan file')
    if environment.get('bundleSha256') != manifest_sha:
        raise Inventory('the web execution ran on another bundle manifest')
    if not is_sha256(environment.get('wasmSha256')):
        raise Inventory('the web environment names no WebAssembly hash')
    allowed = {'environment.json', 'runs.json'}
    records = {}
    for run in plan['runs']:
        allowed.add(f'{run["id"]}.web.json')
        record = read_json(root / f'{run["id"]}.web.json')
        if record.get('id') != run['id'] or record.get('status') not in WEB_STATUSES:
            raise Inventory(f'{run["id"]}: web record identity or status is invalid')
        if record['status'] == 'succeeded':
            allowed.add(run['id'])
        records[run['id']] = record
    present = {path.name for path in root.iterdir()}
    if present != allowed:
        raise Inventory(f'web output does not match the plan: {sorted(present ^ allowed)}')
    return environment, records


def ordinals(values):
    """Integers consecutive in float order: positive floats keep their bits, negative
    floats are minus their magnitude bits, so +0 and -0 are both 0 (signedZeroOnly
    counts those) and the smallest subnormals of either sign are 2 apart."""
    sign = 1 << (values.dtype.itemsize * 8 - 1)
    bits = values.view(f'<u{values.dtype.itemsize}').ravel()
    return [-(int(b) & (sign - 1)) if int(b) & sign else int(b) for b in bits]


def ulp_distance(a, b):
    """Largest ULP distance between finite arrays of one float type, in Python integers."""
    if not a.size:
        return 0
    return max(abs(x - y) for x, y in zip(ordinals(a), ordinals(b)))


def difference(matlab, web):
    """Bitwise comparison of two arrays of one dtype and shape."""
    if matlab.dtype != web.dtype or matlab.shape != web.shape:
        raise Inventory(f'compared arrays differ in type or shape: {matlab.dtype}{matlab.shape} vs {web.dtype}{web.shape}')
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
    masks_equal = bool(numpy.array_equal(finite_m, finite_w))
    result.update({
        'differing': int(numpy.count_nonzero(bitwise)),
        'signedZeroOnly': int(numpy.count_nonzero(bitwise & (matlab == 0) & (web == 0))),
        'nonfiniteMaskEqual': masks_equal and bool(numpy.all(
            (matlab[~finite_m] == web[~finite_w]) | (numpy.isnan(matlab[~finite_m]) & numpy.isnan(web[~finite_w])))),
        'zeroMaskEqual': bool(numpy.array_equal(matlab == 0, web == 0)),
        'maxAbsolute': float(absolute.max()) if absolute.size else 0.0,
        'maxRelative': float((absolute / scale).max()) if absolute.size else 0.0,
        'maxUlp': ulp_distance(a, b),
        'firstDiffering': int(numpy.flatnonzero(bitwise.ravel())[0]),
    })
    return result


def surface_map(path, vertices):
    """The one float32 array of an exported map, which must cover every vertex."""
    try:
        arrays = read_gifti(path)
    except Exception as error:
        raise Inventory(f'{path}: unreadable GIfTI ({error})') from error
    if len(arrays) != 1:
        raise Inventory(f'{path}: expected one GIfTI array, found {len(arrays)}')
    values = arrays[0][2]
    if values.dtype != numpy.dtype('<f4') or values.shape not in ((vertices,), (vertices, 1)):
        raise Inventory(f'{path}: expected float32 over {vertices} vertices, found {values.dtype}{values.shape}')
    return numpy.ascontiguousarray(values.reshape(vertices))


def matlab_results(entries, precision, labels):
    kind, data = entries.get('Srf.Data', (None, None))
    if data is None:
        raise Inventory('Srf.Data is missing')
    dtype = numpy.dtype('<f4' if precision == 'single' else '<f8')
    imaginary = None
    if data.dtype.names == ('real', 'imag'):
        imaginary = numpy.ascontiguousarray(data['imag'])
        data = data['real']
    if kind != precision or data.dtype != dtype or data.ndim != 2 or data.shape[1] != len(labels) or data.shape[0] < 1:
        raise Inventory(f'Srf.Data is {kind} {data.dtype}{data.shape}, expected {precision} rows x {len(labels)} maps')
    actual = []
    for index in range(len(labels)):
        value_kind, value = entries.get(f'Srf.Values{{{index}}}', (None, None))
        actual.append(''.join(chr(int(v)) for v in value.flat) if value_kind == 'char' else None)
    if actual != labels or entries.get(f'Srf.Values{{{len(labels)}}}') is not None:
        raise Inventory(f'Srf.Values {actual} differs from the contract {labels}')
    _, surface = entries.get('Srf.Vertices', (None, None))
    if surface is None or surface.ndim != 2 or surface.shape[0] != 3 or surface.shape[1] < 1:
        raise Inventory('Srf.Vertices is missing or not 3 x N')
    roi_kind, roi = entries.get('Srf.Roi', (None, None))
    if roi is None:
        raise Inventory('Srf.Roi is missing')
    roi_types = {'double': 'f8', 'single': 'f4', 'int8': 'i1', 'uint8': 'u1',
                 'int16': 'i2', 'uint16': 'u2', 'int32': 'i4', 'uint32': 'u4',
                 'int64': 'i8', 'uint64': 'u8'}
    if roi_kind not in roi_types or roi.dtype != numpy.dtype(roi_types[roi_kind]):
        raise Inventory('Srf.Roi must have a numeric MATLAB class and matching dtype')
    roi = numpy.asarray(roi, dtype=numpy.float64).ravel()
    count = surface.shape[1]
    if (roi.size != data.shape[0] or not numpy.all(numpy.isfinite(roi)) or not numpy.all(roi == numpy.round(roi))
            or roi.min() < 1 or roi.max() > count or numpy.unique(roi).size != roi.size):
        raise Inventory('Srf.Roi is not unique integers in 1..vertices, one per Srf.Data row')
    return numpy.ascontiguousarray(data), imaginary, roi.astype(numpy.int64) - 1, count


def names_in(directory):
    if not directory.is_dir():
        raise Inventory(f'missing directory {directory}')
    return {path.name for path in directory.iterdir()}


def web_files(run, web, web_dir):
    """A succeeded web run's exported files: every contract map, at most the polar angle and
    eccentricity maps besides, and exactly what its directory holds beside maps.f64 and,
    when the record names its hash, maps.imag.f64 (the imaginary parts of a complex Srf.Data)."""
    mat, _, maps = expected_results(run)
    files = web.get('files')
    if not isinstance(files, list) or len(set(files)) != len(files) or not set(maps) <= set(files):
        raise Inventory('the web record does not list every contract map')
    stem = mat[:-4]
    web_only = sorted(set(files) - set(maps))
    if not set(web_only) <= {f'{stem}_pol.gii', f'{stem}_ecc.gii'}:
        raise Inventory(f'unexpected web files {web_only}')
    imaginary_sha = web.get('imaginarySha256')
    if imaginary_sha is not None and not is_sha256(imaginary_sha):
        raise Inventory('the web record names an invalid imaginarySha256')
    data_files = {'maps.f64', 'maps.imag.f64'} if imaginary_sha is not None else {'maps.f64'}
    if names_in(web_dir) != set(files) | data_files:
        raise Inventory('the web run directory differs from its record')
    return files, web_only


def matlab_outputs(run, matlab_dir):
    """A succeeded MATLAB run's files beyond its results: every result present, the rest staged
    inputs or SamSrf's intermediate files (MATLAB_EXTRA). Returns those, sorted."""
    mat, _, maps = expected_results(run)
    present = names_in(matlab_dir)
    missing = sorted({mat, *maps} - present)
    if missing:
        raise Inventory(f'missing MATLAB results {missing}')
    matlab_only = sorted(present - {mat, *maps})
    if any(not MATLAB_EXTRA.fullmatch(name) for name in matlab_only):
        raise Inventory(f'unexpected MATLAB files {matlab_only}')
    return matlab_only


def compare_maps(run, web, web_dir, matlab_dir):
    mat, labels, maps = expected_results(run)
    if web.get('values') != labels:
        raise Inventory(f'web map labels {web.get("values")} differ from the contract {labels}')
    _, web_only = web_files(run, web, web_dir)
    matlab_only = matlab_outputs(run, matlab_dir)
    entries = {key: (kind, values) for key, kind, values in read_mat(matlab_dir / mat)}
    data, imaginary, roi, vertices = matlab_results(entries, run['precision'], labels)
    if web.get('vertices') != vertices:
        raise Inventory(f'web vertices {web.get("vertices")} differ from MATLAB surface {vertices}')
    if web.get('roi') != roi.tolist():
        raise Inventory('the web ROI differs from MATLAB Srf.Roi (values or order)')
    def web_rows(name, recorded_sha):
        raw = (web_dir / name).read_bytes()
        if len(raw) != 8 * len(labels) * vertices:
            raise Inventory(f'{name} has {len(raw)} bytes, expected {8 * len(labels) * vertices}')
        if recorded_sha != sha256_bytes(raw):
            raise Inventory(f'{name} differs from the hash its record names')
        return numpy.frombuffer(raw, dtype='<f8').reshape(len(labels), vertices)

    rows = web_rows('maps.f64', web.get('mapsSha256'))
    imaginary_sha = web.get('imaginarySha256')
    imaginary_rows = numpy.zeros_like(rows) if imaginary_sha is None else web_rows('maps.imag.f64', imaginary_sha)
    results = []
    for index, (label, name) in enumerate(zip(labels, maps)):
        column = data[:, index]
        matlab_imaginary = numpy.zeros_like(column) if imaginary is None else imaginary[:, index]
        web_values = rows[index, roi]
        web_imaginary = imaginary_rows[index, roi]
        cast = web_values.astype(column.dtype)
        cast_imaginary = web_imaginary.astype(column.dtype)
        entry = {'label': label, 'file': name,
                 'castExact': bool(numpy.array_equal(cast.astype(numpy.float64), web_values, equal_nan=True)
                                   and numpy.array_equal(cast_imaginary.astype(numpy.float64), web_imaginary, equal_nan=True)),
                 'srfData': difference(column, cast),
                 'imaginary': difference(numpy.ascontiguousarray(matlab_imaginary), cast_imaginary)}
        entry['imaginaryNonzero'] = int(numpy.count_nonzero(matlab_imaginary))
        if entry['imaginaryNonzero']:
            entry['maxImaginary'] = float(numpy.max(numpy.abs(matlab_imaginary)))
        entry['gifti'] = difference(surface_map(matlab_dir / name, vertices), surface_map(web_dir / name, vertices))
        entry['class'] = ('exact' if entry['castExact'] and entry['srfData']['exact']
                          and entry['imaginary']['exact'] and entry['gifti']['exact'] else 'differs')
        results.append(entry)
    for name in web_only:
        surface_map(web_dir / name, vertices)
    return results, imaginary is not None, web_only, matlab_only


def compare_run(run, web, matlab, runner, web_root, matlab_root):
    expected = expected_web_outcome(run, runner)
    report = {'id': run['id'], 'precision': run['precision'], 'algorithm': run['algorithm'],
              'status': {'web': web['status'], 'matlab': matlab['status'], 'expectedWeb': expected['status']},
              'maps': []}
    if web.get('message') or matlab.get('message'):
        report['message'] = {'web': web.get('message'), 'matlab': matlab.get('message')}
    refusal = 'message' in expected
    if refusal and web['status'] == expected['status'] and web.get('message') != expected['message']:
        report['expectedMessage'] = expected['message']
    if (matlab['status'] != 'succeeded' or web['status'] != expected['status'] or web['status'] == 'failed'
            or 'expectedMessage' in report):
        report['class'] = 'failed'
        return report
    if refusal:
        report['class'] = expected['status']
        return report
    try:
        maps, complex_data, web_only, matlab_only = compare_maps(run, web, web_root / run['id'], matlab_root / run['id'])
    except Inventory as error:
        report['class'] = 'inventory-error'
        report['error'] = str(error)
        return report
    report.update({'maps': maps, 'matlabComplex': complex_data,
                   'notCompared': {'webOnly': web_only, 'matlabOnly': matlab_only}})
    report['class'] = 'exact' if all(entry['class'] == 'exact' for entry in maps) else 'differs'
    return report


def compare(plan, plan_sha, manifest, manifest_sha, web_root, matlab_root, expect, allow_unattested=False):
    web_root = Path(web_root)
    matlab_root = Path(matlab_root)
    validate_plan(plan, manifest)
    identity, receipts = matlab_execution(matlab_root, plan, manifest, allow_unattested)
    if identity['kind'] != expect:
        raise Inventory(f'expected a {expect} execution, the receipts record {identity["kind"]}')
    environment, records = web_execution(web_root, plan, plan_sha, manifest_sha)
    runs = [compare_run(run, records[run['id']], receipts[run['id']], environment['runner'], web_root, matlab_root)
            for run in plan['runs']]
    maps = [entry for run in runs for entry in run['maps']]
    count = lambda items, value: sum(item['class'] == value for item in items)
    failed = [run for run in runs if run['class'] == 'failed']
    return {
        'plan': {'sha256': plan_sha, 'runs': len(plan['runs'])},
        'bundleManifestSha256': manifest_sha,
        'matlab': identity,
        'web': environment,
        'runs': runs,
        'summary': {
            'runs': len(runs),
            **{f'{value}Runs': count(runs, value) for value in ('exact', 'differs', 'refused', 'unsupported', 'failed', 'inventory-error')},
            'matlabFailedRuns': sum(run['status']['matlab'] != 'succeeded' for run in failed),
            'webUnexpectedRuns': sum(run['status']['web'] != run['status']['expectedWeb'] or run['status']['web'] == 'failed'
                                     or 'expectedMessage' in run for run in failed),
            'maps': len(maps),
            'exactMaps': count(maps, 'exact'),
            'differingMaps': count(maps, 'differs'),
            'webOnlyFilesNotCompared': sum(len(run.get('notCompared', {}).get('webOnly', [])) for run in runs),
        },
    }


def main(arguments=None):
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    parser.add_argument('plan')
    parser.add_argument('manifest')
    parser.add_argument('web_root')
    parser.add_argument('matlab_root')
    parser.add_argument('report')
    parser.add_argument('--expect', required=True, choices=sorted(RECEIPT_EXECUTION))
    parser.add_argument('--allow-unattested-source-inputs', action='store_true')
    options = parser.parse_args(arguments)
    plan_bytes = Path(options.plan).read_bytes()
    manifest_bytes = Path(options.manifest).read_bytes()
    plan = json.loads(plan_bytes)
    if plan != cli_plan.plan():
        raise SystemExit("The plan is not cli_plan.py's matrix")
    try:
        report = compare(plan, sha256_bytes(plan_bytes), json.loads(manifest_bytes), sha256_bytes(manifest_bytes),
                         options.web_root, options.matlab_root, options.expect, options.allow_unattested_source_inputs)
    except Inventory as error:
        raise SystemExit(f'Refused: {error}') from error
    with Path(options.report).open('x') as output:
        json.dump(report, output, indent=2)
        output.write('\n')
    for run in report['runs']:
        if run['class'] in ('exact', 'differs'):
            maps = []
            for entry in run['maps']:
                raw = 'exact' if entry['srfData']['exact'] else entry['srfData']['differing']
                imaginary = 'exact' if entry['imaginary']['exact'] else entry['imaginary']['differing']
                gifti = 'exact' if entry['gifti']['exact'] else entry['gifti']['differing']
                maps.append(f'{entry["label"]}: raw={raw} imaginary={imaginary} gifti={gifti} '
                            f'castExact={entry["castExact"]} imaginaryNonzero={entry["imaginaryNonzero"]}')
            detail = ', '.join(maps)
        else:
            detail = run.get('error') or json.dumps(run.get('message', run['status']))
        print(f'{run["class"]:<15} {run["id"]:<36} {detail}')
    print(json.dumps(report['summary']))
    if report['summary']['inventory-errorRuns'] or report['summary']['failedRuns']:
        raise SystemExit('Inventory errors or failed runs; see the report')


if __name__ == '__main__':
    main()
