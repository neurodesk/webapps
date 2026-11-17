#!/usr/bin/env python3
"""Hold the production web app's downloads (run_ui_matrix.mjs) against a MATLAB execution.

    compare_ui_cli.py PLAN BUNDLE_SHA256 UI_ROOT MATLAB_ROOT REPORT
        --expect source|compiled-runtime [--allow-unattested-source-inputs]
        [--engine-root WEB_ROOT]

The interface downloads float32 GIfTIs only, so each contract map is compared
bitwise twice: against MATLAB's exported GIfTI over every vertex, and against
MATLAB's Srf.Data column over Srf.Roi cast to float32. A double-precision run's
own double values are not observable through the interface; the report says so
per run (`srfDataCast`), and compare_web_cli.py holds the engine's double rows.
With --engine-root, every downloaded file must also equal, byte for byte, the
file of the same name the engine harness (run_web_matrix.mjs or
run_browser_matrix.mjs) exported for that run: the production bundle and the
engine module then wrote the same bytes.

The plan, the bundle manifest and the MATLAB receipts are checked exactly as
compare_web_cli.py checks them. A run is `refused` or `unsupported` only where
compare_web_cli.expected_web_status says the browser is expected to be, with
MATLAB succeeding; `succeeded-ui-error` runs are compared, and counted apart,
because the interface reported an error after offering its result. Anything else
is `failed`. No tolerance is applied. Failed and inventory-error runs exit nonzero.
"""

import argparse
import json
import sys
import zipfile
from pathlib import Path

import numpy

from compare_cli import expected_results, read_mat
from compare_web_cli import (Inventory, difference, expected_web_status, matlab_execution, matlab_results,
                             read_json, sha256_bytes, surface_map, validate_plan)

UI_STATUSES = {'succeeded', 'succeeded-ui-error', 'refused', 'unsupported', 'failed'}


def ui_execution(root, plan, plan_sha, manifest_sha):
    environment = read_json(root / 'environment.json')
    if environment.get('runner') != 'production-ui':
        raise Inventory('the UI environment does not name the production-ui runner')
    if environment.get('planSha256') != plan_sha or environment.get('bundleSha256') != manifest_sha:
        raise Inventory('the UI execution ran another plan or bundle manifest')
    if not isinstance(environment.get('wasmSha256'), str) or len(environment['wasmSha256']) != 64:
        raise Inventory('the UI environment names no served WebAssembly hash')
    records = {}
    for run in plan['runs']:
        record = read_json(root / f'{run["id"]}.ui.json')
        if record.get('id') != run['id'] or record.get('status') not in UI_STATUSES:
            raise Inventory(f'{run["id"]}: UI record identity or status is invalid')
        records[run['id']] = record
    return environment, records


def with_nan_signs(result, matlab, ui):
    """difference() plus how many differing values are NaN on both sides (sign or payload bits)."""
    if not result['exact']:
        bitwise = matlab.view('<u4') != ui.view('<u4')
        result['nanSignOnly'] = int(numpy.count_nonzero(bitwise & numpy.isnan(matlab) & numpy.isnan(ui)))
    return result


def downloaded(run_dir, record):
    """The GIfTIs of the downloaded zip, checked against the hash the record names."""
    archive = run_dir / str(record.get('zip'))
    data = archive.read_bytes()
    if sha256_bytes(data) != record.get('zipSha256'):
        raise Inventory('the downloaded zip differs from the hash its record names')
    with zipfile.ZipFile(archive) as handle:
        names = handle.namelist()
        if len(set(names)) != len(names):
            raise Inventory('the downloaded zip repeats a file name')
        return {name: handle.read(name) for name in names}


def compare_maps(run, record, run_dir, matlab_dir, engine_dir, scratch):
    mat, labels, maps = expected_results(run)
    files = downloaded(run_dir, record)
    stem = mat[:-4]
    if not set(maps) <= set(files):
        raise Inventory(f'the download lacks contract maps {sorted(set(maps) - set(files))}')
    ui_only = sorted(set(files) - set(maps))
    if not set(ui_only) <= {f'{stem}_pol.gii', f'{stem}_ecc.gii'}:
        raise Inventory(f'unexpected downloaded files {ui_only}')
    entries = {key: (kind, values) for key, kind, values in read_mat(matlab_dir / mat)}
    data, imaginary, roi, vertices = matlab_results(entries, run['precision'], labels)
    scratch.mkdir(parents=True, exist_ok=True)
    for name, payload in files.items():
        (scratch / name).write_bytes(payload)
    results = []
    for index, (label, name) in enumerate(zip(labels, maps)):
        ui_values = surface_map(scratch / name, vertices)
        column = data[:, index]
        matlab_values = surface_map(matlab_dir / name, vertices)
        cast = numpy.ascontiguousarray(column.astype('<f4'))
        roi_values = numpy.ascontiguousarray(ui_values[roi])
        entry = {'label': label, 'file': name,
                 'gifti': with_nan_signs(difference(matlab_values, ui_values), matlab_values, ui_values),
                 'srfDataCast': with_nan_signs(difference(cast, roi_values), cast, roi_values),
                 'srfDataPrecision': run['precision']}
        entry['imaginaryNonzero'] = 0 if imaginary is None else int(numpy.count_nonzero(imaginary[:, index]))
        entry['class'] = ('exact' if not entry['imaginaryNonzero'] and entry['gifti']['exact']
                          and entry['srfDataCast']['exact'] else 'differs')
        results.append(entry)
    for name in ui_only:
        surface_map(scratch / name, vertices)
    engine = None
    if engine_dir is not None:
        engine = {'equal': [], 'differ': [], 'missing': []}
        for name, payload in sorted(files.items()):
            other = engine_dir / name
            bucket = 'missing' if not other.is_file() else 'equal' if other.read_bytes() == payload else 'differ'
            engine[bucket].append(name)
    return results, ui_only, engine


def compare_run(run, record, matlab, ui_root, matlab_root, engine_root, scratch):
    expected = expected_web_status(run, 'browser')
    report = {'id': run['id'], 'precision': run['precision'], 'algorithm': run['algorithm'],
              'status': {'ui': record['status'], 'matlab': matlab['status'], 'expectedWeb': expected}, 'maps': []}
    for key in ('stage', 'message', 'runMessage', 'uiError'):
        if record.get(key):
            report[key] = record[key]
    computed = record['status'] in ('succeeded', 'succeeded-ui-error')
    if matlab['status'] != 'succeeded' or (record['status'] != expected and not (computed and expected == 'succeeded')):
        report['class'] = 'failed'
        return report
    if expected in ('refused', 'unsupported'):
        report['class'] = expected
        return report
    try:
        maps, ui_only, engine = compare_maps(run, record, ui_root / run['id'], matlab_root / run['id'],
                                             engine_root / run['id'] if engine_root else None, scratch / run['id'])
    except Inventory as error:
        report['class'] = 'inventory-error'
        report['error'] = str(error)
        return report
    report.update({'maps': maps, 'notCompared': {'uiOnly': ui_only}, 'engineFiles': engine})
    report['class'] = 'exact' if all(entry['class'] == 'exact' for entry in maps) else 'differs'
    return report


def compare(plan, plan_sha, manifest, manifest_sha, ui_root, matlab_root, expect, allow_unattested=False,
            engine_root=None, scratch=None):
    ui_root = Path(ui_root)
    matlab_root = Path(matlab_root)
    validate_plan(plan, manifest)
    identity, receipts = matlab_execution(matlab_root, plan, manifest, allow_unattested)
    if identity['kind'] != expect:
        raise Inventory(f'expected a {expect} execution, the receipts record {identity["kind"]}')
    environment, records = ui_execution(ui_root, plan, plan_sha, manifest_sha)
    runs = [compare_run(run, records[run['id']], receipts[run['id']], ui_root, matlab_root,
                        Path(engine_root) if engine_root else None, Path(scratch))
            for run in plan['runs']]
    maps = [entry for run in runs for entry in run['maps']]
    count = lambda items, value: sum(item['class'] == value for item in items)
    engines = [run['engineFiles'] for run in runs if run.get('engineFiles')]
    return {
        'plan': {'sha256': plan_sha, 'runs': len(plan['runs'])},
        'bundleManifestSha256': manifest_sha,
        'matlab': identity,
        'ui': environment,
        'runs': runs,
        'summary': {
            'runs': len(runs),
            **{f'{value}Runs': count(runs, value) for value in ('exact', 'differs', 'refused', 'unsupported', 'failed', 'inventory-error')},
            'uiErrorRuns': sum(run['status']['ui'] == 'succeeded-ui-error' for run in runs),
            'maps': len(maps),
            'exactMaps': count(maps, 'exact'),
            'differingMaps': count(maps, 'differs'),
            'uiOnlyFilesNotCompared': sum(len(run.get('notCompared', {}).get('uiOnly', [])) for run in runs),
            'engineFilesEqual': sum(len(item['equal']) for item in engines) if engine_root else None,
            'engineFilesDiffer': sum(len(item['differ']) + len(item['missing']) for item in engines) if engine_root else None,
        },
    }


def line(run):
    if run['class'] in ('exact', 'differs'):
        mark = lambda d: 'exact' if d['exact'] else f'{d["differing"]}' + (f'(nanSign {d["nanSignOnly"]})' if d.get('nanSignOnly') else '')
        parts = [f'{m["label"]}: gifti={mark(m["gifti"])} '
                 f'srfData(f32)={mark(m["srfDataCast"])} '
                 f'imaginaryNonzero={m["imaginaryNonzero"]}' for m in run['maps']]
        engine = run.get('engineFiles')
        if engine is not None:
            parts.append(f'engineFiles equal={len(engine["equal"])} differ={len(engine["differ"])} missing={len(engine["missing"])}')
        if run['status']['ui'] == 'succeeded-ui-error':
            parts.append(f'uiError={run.get("uiError")!r}')
        return ', '.join(parts)
    return json.dumps({key: run.get(key) for key in ('stage', 'message', 'runMessage', 'error') if run.get(key)})


def main(arguments=None):
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    for name in ('plan', 'manifest', 'ui_root', 'matlab_root', 'report'):
        parser.add_argument(name)
    parser.add_argument('--expect', required=True, choices=['source', 'compiled-runtime'])
    parser.add_argument('--allow-unattested-source-inputs', action='store_true')
    parser.add_argument('--engine-root')
    args = parser.parse_args(arguments)
    plan_path = Path(args.plan)
    manifest_path = Path(args.manifest)
    report_path = Path(args.report)
    try:
        report = compare(read_json(plan_path), sha256_bytes(plan_path.read_bytes()), read_json(manifest_path),
                         sha256_bytes(manifest_path.read_bytes()), args.ui_root, args.matlab_root, args.expect,
                         args.allow_unattested_source_inputs, args.engine_root,
                         report_path.with_name(report_path.stem + '-extracted'))
    except Inventory as error:
        print(f'refused: {error}', file=sys.stderr)
        return 2
    report_path.write_text(json.dumps(report, indent=2) + '\n')
    for run in report['runs']:
        print(f'{run["class"]:15} {run["id"]:36} {line(run)}')
    print(json.dumps(report['summary']))
    return 1 if report['summary']['failedRuns'] or report['summary']['inventory-errorRuns'] else 0


if __name__ == '__main__':
    sys.exit(main())
