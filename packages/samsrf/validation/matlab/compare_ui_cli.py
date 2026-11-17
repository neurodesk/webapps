#!/usr/bin/env python3
"""Hold the production web app's downloads (run_ui_matrix.mjs) against a MATLAB execution.

    compare_ui_cli.py PLAN BUNDLE_SHA256 UI_ROOT MATLAB_ROOT REPORT
        --expect source|compiled-runtime --engine-root WEB_ROOT [--allow-unattested-source-inputs]

PLAN must be cli_plan.py's whole matrix. WEB_ROOT is the engine harness's run of the same
plan file (run_web_matrix.mjs or run_browser_matrix.mjs).

The comparison is refused (exit 2) unless, before any value is read:

- the plan, the bundle manifest and the MATLAB receipts pass compare_web_cli.py's checks,
  and WEB_ROOT passes them as compare_web_cli.py checks a web execution;
- the UI execution names this plan file and bundle manifest, and the SHA-256 of the
  WebAssembly module the page fetched, which must be the module the engine harness ran;
- UI_ROOT holds exactly environment.json, runs.json, one record per run and run directories.

A run directory holds exactly the files its record names, or the run is `inventory-error`.
app-model.json is the model the app saved before Run: its bytes hash to appModelSha256,
and its content is the plan model with Data_Precision added and the input files named as
the app names them. The zip's bytes hash to zipSha256, and it holds exactly the contract
maps and the polar angle and eccentricity maps.

The interface downloads float32 GIfTIs only, so each contract map is compared bitwise
twice: against MATLAB's exported GIfTI over every vertex, and against MATLAB's Srf.Data
column over Srf.Roi cast to float32. A double-precision run's own double values are not
observable through the interface; each map says which precision its Srf.Data comparison
stands for (`srfDataPrecision`), and compare_web_cli.py holds the engine's double rows.

Each run is classed:

- `exact` / `differs`: the app completed the run: its status line shows the run's
  outcome, it offers the download, and the page threw nothing.
- `ui-error`: the app offered a result, then showed an error or threw. The workflow did
  not complete. Its downloads are compared and reported (`downloads`); it is not agreement.
- `refused` / `unsupported`: MATLAB succeeded, and the app refused the run with the exact
  text expected_ui_outcome names, and offered nothing.
- `failed`: anything else.

Engine equality is its own gate: for every run the app computed, the zip must hold exactly
the files the engine harness exported for that run, each equal byte for byte. MATLAB
numerical differences are reported, never gated, and no tolerance is applied.

Exit status: 0 when every run is exact, differs, refused or unsupported and the engine gate
holds; 1 when a run is failed, ui-error or inventory-error, or the engine gate fails (the
report's `failures` says which); 2 when the comparison is refused.
"""

import argparse
import io
import json
from pathlib import Path, PurePosixPath
import sys
import zipfile

import numpy

import cli_plan
from compare_cli import expected_results, read_mat
from compare_web_cli import (Inventory, difference, expected_web_status, is_sha256, matlab_execution, matlab_outputs,
                             matlab_results, names_in, read_json, sha256_bytes, surface_map, validate_plan,
                             web_execution, web_files)

UI_STATUSES = {'succeeded', 'succeeded-ui-error', 'refused', 'unsupported', 'failed'}
COMPUTED = {'succeeded', 'succeeded-ui-error'}
CLASSES = ('exact', 'differs', 'refused', 'unsupported', 'ui-error', 'failed', 'inventory-error')
# apps/samsrf/src/models.js parseModel, shown when the model loads.
MODEL_REFUSALS = {
    'rc': 'Single precision reverse correlation supports the convex hull; 2D pRF fits need double precision.',
    'cf': 'Single precision connective fields support Fit_pRF 0 or -1; Gaussian fits need double precision.',
}
# The record field that keeps the status line after the model loads, or after Run.
MESSAGE_FIELD = {'model': 'message', 'run': 'runMessage'}


def expected_ui_outcome(run):
    """What the app must do with a plan run; run_ui_matrix.mjs's expectedOutcome says the same."""
    status = expected_web_status(run, 'browser')
    if status == 'refused':
        return {'status': status, 'stage': 'model', 'message': MODEL_REFUSALS[run['algorithm']]}
    if status == 'unsupported':
        # exes/samsrf/core/src/hrf.rs resolve(): the app has no subject-HRF file route.
        return {'status': status, 'stage': 'run',
                'message': f'model: Hrf {run["model"]["Hrf"]} is an old-school HRF fit file: '
                           'the caller must load its fP and call hrf::old_school'}
    return {'status': status}


def expected_app_model(run):
    """The plan model as the app saves it: Data_Precision added, input files named by their stems."""
    model = {**run['model'], 'Data_Precision': run['precision']}
    if run['algorithm'] == 'cf':
        model['SeedRoi'] = PurePosixPath(model['SeedRoi']).name
        # The app reads the Benson GIfTI that prepare_cli_bundle.m converted for MATLAB.
        model['Template'] = f'{cli_plan.DATASETS[run["dataset"]]["hemisphere"]}_benson'
    else:
        model['Aperture_File'] = PurePosixPath(model['Aperture_File']).name
    return model


def canonical(value):
    """JSON text, which keeps true and false apart from 1 and 0 where Python's == does not."""
    return json.dumps(value, sort_keys=True, allow_nan=False)


def ui_execution(root, plan, plan_sha, manifest_sha):
    environment = read_json(root / 'environment.json')
    if environment.get('runner') != 'production-ui':
        raise Inventory('the UI environment does not name the production-ui runner')
    if environment.get('planSha256') != plan_sha or environment.get('bundleSha256') != manifest_sha:
        raise Inventory('the UI execution ran another plan or bundle manifest')
    if not is_sha256(environment.get('wasmSha256')):
        raise Inventory('the UI environment names no served WebAssembly hash')
    required = {'environment.json', 'runs.json'}
    records = {}
    for run in plan['runs']:
        required.add(f'{run["id"]}.ui.json')
        record = read_json(root / f'{run["id"]}.ui.json')
        if record.get('id') != run['id'] or record.get('status') not in UI_STATUSES:
            raise Inventory(f'{run["id"]}: UI record identity or status is invalid')
        records[run['id']] = record
    present = names_in(root)
    unexpected = present - required - set(records)
    if unexpected or not required <= present:
        raise Inventory(f'UI output does not match the plan: {sorted(unexpected | (required - present))}')
    return environment, records


def check_run_directory(run, record, run_dir):
    """The run directory holds exactly the files its record names, and the saved model is the plan's."""
    status = record['status']
    needed = {'appModelSha256', 'zip', 'zipSha256'} if status in COMPUTED else (
        {'appModelSha256'} if status == 'unsupported' else set())
    if needed - set(record):
        raise Inventory(f'the {status} record names no {sorted(needed - set(record))}')
    if 'zip' in record and not isinstance(record['zip'], str):
        raise Inventory('the record names its zip with something other than a file name')
    named = {name for name, key in (('app-model.json', 'appModelSha256'), (record.get('zip'), 'zip')) if key in record}
    present = names_in(run_dir) if run_dir.exists() else set()
    if present != named:
        raise Inventory(f'the run directory differs from its record: {sorted(present ^ named)}')
    if 'appModelSha256' in record:
        data = (run_dir / 'app-model.json').read_bytes()
        if not is_sha256(record['appModelSha256']) or sha256_bytes(data) != record['appModelSha256']:
            raise Inventory('app-model.json differs from the hash its record names')
        try:
            saved = json.loads(data)
        except ValueError as error:
            raise Inventory(f'app-model.json is not JSON ({error})') from error
        if canonical(saved) != canonical(expected_app_model(run)):
            raise Inventory('the model the app saved is not the plan model')


def with_nan_signs(result, matlab, ui):
    """difference() plus how many differing values are NaN on both sides (sign or payload bits)."""
    if not result['exact']:
        bitwise = matlab.view('<u4') != ui.view('<u4')
        result['nanSignOnly'] = int(numpy.count_nonzero(bitwise & numpy.isnan(matlab) & numpy.isnan(ui)))
    return result


def downloaded(run_dir, record):
    """The files of the downloaded zip, whose bytes must hash to the record's zipSha256."""
    data = (run_dir / record['zip']).read_bytes()
    if not is_sha256(record['zipSha256']) or sha256_bytes(data) != record['zipSha256']:
        raise Inventory('the downloaded zip differs from the hash its record names')
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as handle:
            names = handle.namelist()
            if len(set(names)) != len(names):
                raise Inventory('the downloaded zip repeats a file name')
            return {name: handle.read(name) for name in names}
    except zipfile.BadZipFile as error:
        raise Inventory(f'the download is not a zip ({error})') from error


def engine_files(run, files, engine, engine_dir):
    """Each downloaded file against the engine harness's export of the same run, byte for byte."""
    exported = set(web_files(run, engine, engine_dir)[0]) if engine['status'] == 'succeeded' else set()
    shared = sorted(set(files) & exported)
    equal = [name for name in shared if (engine_dir / name).read_bytes() == files[name]]
    return {'engineStatus': engine['status'], 'equal': equal, 'differ': sorted(set(shared) - set(equal)),
            'onlyDownloaded': sorted(set(files) - exported), 'onlyEngine': sorted(exported - set(files))}


def engine_equal(result):
    return result['engineStatus'] == 'succeeded' and not (
        result['differ'] or result['onlyDownloaded'] or result['onlyEngine'])


def compare_downloads(run, record, run_dir, matlab_dir, engine, engine_dir, scratch):
    mat, labels, maps = expected_results(run)
    stem = mat[:-4]
    files = downloaded(run_dir, record)
    contract = {*maps, f'{stem}_pol.gii', f'{stem}_ecc.gii'}
    if set(files) != contract:
        raise Inventory(f'the download is not the contract, polar angle and eccentricity maps: '
                        f'{sorted(set(files) ^ contract)}')
    ui_only = sorted(contract - set(maps))
    matlab_only = matlab_outputs(run, matlab_dir)
    entries = {key: (kind, values) for key, kind, values in read_mat(matlab_dir / mat)}
    data, imaginary, roi, vertices = matlab_results(entries, run['precision'], labels)
    scratch.mkdir(parents=True)
    for name, payload in files.items():
        (scratch / name).write_bytes(payload)
    results = []
    for index, (label, name) in enumerate(zip(labels, maps)):
        ui_values = surface_map(scratch / name, vertices)
        matlab_values = surface_map(matlab_dir / name, vertices)
        cast = numpy.ascontiguousarray(data[:, index].astype('<f4'))
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
    return results, ui_only, matlab_only, engine_files(run, files, engine, engine_dir)


def compare_run(run, record, matlab, engine, roots, scratch):
    ui_root, matlab_root, engine_root = roots
    expected = expected_ui_outcome(run)
    report = {'id': run['id'], 'precision': run['precision'], 'algorithm': run['algorithm'],
              'status': {'ui': record['status'], 'expectedUi': expected['status'], 'matlab': matlab['status'],
                         'engine': engine['status']},
              'maps': []}
    for key in ('stage', 'message', 'runMessage', 'uiError', 'pageErrors'):
        if record.get(key):
            report[key] = record[key]
    try:
        check_run_directory(run, record, ui_root / run['id'])
        if matlab['status'] != 'succeeded':
            return {**report, 'class': 'failed'}
        if expected['status'] != 'succeeded':
            as_expected = (record['status'] == expected['status'] and 'zip' not in record
                           and not record.get('pageErrors')
                           and record.get(MESSAGE_FIELD[expected['stage']]) == expected['message'])
            return {**report, 'class': expected['status'] if as_expected else 'failed'}
        if record['status'] not in COMPUTED:
            return {**report, 'class': 'failed'}
        maps, ui_only, matlab_only, engine_result = compare_downloads(
            run, record, ui_root / run['id'], matlab_root / run['id'], engine, engine_root / run['id'],
            scratch / run['id'])
    except Inventory as error:
        return {**report, 'class': 'inventory-error', 'error': str(error)}
    downloads = 'exact' if all(entry['class'] == 'exact' for entry in maps) else 'differs'
    completed = record['status'] == 'succeeded' and not record.get('pageErrors')
    report.update({'maps': maps, 'downloads': downloads, 'engineFiles': engine_result,
                   'notCompared': {'uiOnly': ui_only, 'matlabOnly': matlab_only},
                   'class': downloads if completed else 'ui-error'})
    return report


def compare(plan, plan_sha, manifest, manifest_sha, ui_root, matlab_root, engine_root, expect, scratch,
            allow_unattested=False):
    ui_root, matlab_root, engine_root, scratch = (Path(path) for path in (ui_root, matlab_root, engine_root, scratch))
    if scratch.exists():
        raise Inventory(f'{scratch} already exists')
    validate_plan(plan, manifest)
    identity, receipts = matlab_execution(matlab_root, plan, manifest, allow_unattested)
    if identity['kind'] != expect:
        raise Inventory(f'expected a {expect} execution, the receipts record {identity["kind"]}')
    environment, records = ui_execution(ui_root, plan, plan_sha, manifest_sha)
    engine_environment, engine_records = web_execution(engine_root, plan, plan_sha, manifest_sha)
    if engine_environment['wasmSha256'] != environment['wasmSha256']:
        raise Inventory('the page served another WebAssembly module than the engine harness ran')
    runs = [compare_run(run, records[run['id']], receipts[run['id']], engine_records[run['id']],
                        (ui_root, matlab_root, engine_root), scratch)
            for run in plan['runs']]
    maps = [entry for run in runs for entry in run['maps']]
    count = lambda items, value: sum(item['class'] == value for item in items)
    engines = {run['id']: run['engineFiles'] for run in runs if 'engineFiles' in run}
    mismatched = sorted(run_id for run_id, result in engines.items() if not engine_equal(result))
    summary = {
        'runs': len(runs),
        **{f'{value}Runs': count(runs, value) for value in CLASSES},
        'completedRuns': count(runs, 'exact') + count(runs, 'differs'),
        'downloadRuns': len(engines),
        'exactDownloadRuns': sum(run.get('downloads') == 'exact' for run in runs),
        'maps': len(maps),
        'exactMaps': count(maps, 'exact'),
        'differingMaps': count(maps, 'differs'),
        'uiOnlyFilesNotCompared': sum(len(run.get('notCompared', {}).get('uiOnly', [])) for run in runs),
        'engineFilesEqual': sum(len(result['equal']) for result in engines.values()),
        'engineFilesDiffer': sum(len(result['differ']) + len(result['onlyDownloaded']) + len(result['onlyEngine'])
                                 for result in engines.values()),
        'engineMismatchRuns': len(mismatched),
    }
    failures = [f'{summary[f"{value}Runs"]} {text}' for value, text in (
        ('failed', 'runs failed'),
        ('inventory-error', 'runs have inventory errors'),
        ('ui-error', 'runs showed an interface error after offering a result: those workflows did not complete'),
    ) if summary[f'{value}Runs']]
    if mismatched:
        failures.append(f'downloads are not the engine harness export in {len(mismatched)} runs: {mismatched}')
    return {
        'plan': {'sha256': plan_sha, 'runs': len(plan['runs']), 'canonical': plan == cli_plan.plan()},
        'bundleManifestSha256': manifest_sha,
        'matlab': identity,
        'ui': environment,
        'engine': engine_environment,
        'runs': runs,
        'summary': summary,
        'failures': failures,
    }


def line(run):
    if 'downloads' in run:
        mark = lambda d: 'exact' if d['exact'] else f'{d["differing"]}' + (f'(nanSign {d["nanSignOnly"]})' if d.get('nanSignOnly') else '')
        parts = [f'{m["label"]}: gifti={mark(m["gifti"])} '
                 f'srfData(f32)={mark(m["srfDataCast"])} '
                 f'imaginaryNonzero={m["imaginaryNonzero"]}' for m in run['maps']]
        engine = run['engineFiles']
        parts.append(f'engineFiles equal={len(engine["equal"])} differ={len(engine["differ"])} '
                     f'onlyDownloaded={len(engine["onlyDownloaded"])} onlyEngine={len(engine["onlyEngine"])}')
        if run['class'] == 'ui-error':
            parts.append(f'downloads={run["downloads"]} uiError={run.get("uiError") or run.get("pageErrors")!r}')
        return ', '.join(parts)
    return json.dumps({key: run.get(key) for key in ('stage', 'message', 'runMessage', 'error') if run.get(key)})


def main(arguments=None):
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    for name in ('plan', 'manifest', 'ui_root', 'matlab_root', 'report'):
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
                         args.ui_root, args.matlab_root, args.engine_root, args.expect,
                         report_path.with_name(report_path.stem + '-extracted'), args.allow_unattested_source_inputs)
    except Inventory as error:
        print(f'refused: {error}', file=sys.stderr)
        return 2
    with report_path.open('x') as output:
        json.dump(report, output, indent=2)
        output.write('\n')
    for run in report['runs']:
        print(f'{run["class"]:15} {run["id"]:36} {line(run)}')
    print(json.dumps(report['summary']))
    for failure in report['failures']:
        print(f'failed: {failure}', file=sys.stderr)
    return 1 if report['failures'] else 0


if __name__ == '__main__':
    sys.exit(main())
