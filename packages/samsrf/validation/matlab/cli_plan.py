#!/usr/bin/env python3
"""One case matrix for SamSrfAnalysis, run by source MATLAB and by the compiled image.

Both executions receive the same argv, the same read-only bundle at /input and
fresh result directories with identical SamSrf_defaults.json bytes. Only the
results path differs: it is substituted for RESULTS in each argv.

Usage:
  cli_plan.py plan PLAN_JSON
  cli_plan.py models PLAN_JSON BUNDLE
  cli_plan.py stage PLAN_JSON BUNDLE RESULTS_ROOT
  cli_plan.py hash BUNDLE MANIFEST_JSON
  cli_plan.py verify BUNDLE MANIFEST_JSON
  cli_plan.py verify-inputs PLAN_JSON BUNDLE MANIFEST_JSON RESULTS_ROOT
"""
import hashlib
import json
from pathlib import Path
import sys

INPUT = '/input'
RESULTS = '{results}'
PRECISIONS = ('double', 'single')
DATASETS = {
    'x001_lh': {'hemisphere': 'lh', 'runs': 6, 'radius': 9.5, 'tr': 1},
    'x001_rh': {'hemisphere': 'rh', 'runs': 1, 'radius': 9.5, 'tr': 1},
}
GAUSSIAN = '@(P,ApWidth)prf_gaussian_rf(P(1),P(2),P(3),ApWidth)'


def forward(dataset, aperture):
    radius = DATASETS[dataset]['radius']
    # record_matrix.m's forward model, so these cases sit beside the source matrix.
    return {
        'Prf_Function': GAUSSIAN,
        'Param_Names': ['x0', 'y0', 'Sigma'],
        'Scaled_Param': [1, 1, 1],
        'Only_Positive': [0, 0, 1],
        'Scaling_Factor': radius,
        'TR': DATASETS[dataset]['tr'],
        'Downsample_Predictions': 1,
        'Hrf': 0,
        'Aperture_File': f'{INPUT}/apertures/{aperture}',
        'Param1': [-0.6 * radius, 0, 0.6 * radius],
        'Param2': [-0.6 * radius, 0, 0.6 * radius],
        'Param3': [0.125 * radius, 0.333 * radius],
        'Replace_Bad_Fits': False,
        'Fine_Fit_Threshold': 0.01,
        'Noise_Ceiling_Threshold': 0,
    }


def reverse_correlation(**changes):
    return {
        'Aperture_File': f'{INPUT}/apertures/aps_bars',
        'Scaling_Factor': 9.5, 'TR': 1, 'Hrf': 0, 'Rdim': 100,
        'Prf_Function': 0, 'Allow_Negative_Peaks': False, **changes,
    }


def connective_field(dataset, mode, smoothing=0, correct=False):
    hemisphere = DATASETS[dataset]['hemisphere']
    return {
        # prepare_cli_bundle.m writes one Benson template per precision.
        'Template': f'{INPUT}/{dataset}/{hemisphere}_benson_{{precision}}.mat',
        'SeedRoi': f'{INPUT}/{dataset}/seed',
        'Fit_pRF': mode, 'Smoothing': smoothing,
        'Global_Signal_Correction': correct,
    }


RC_GAUSSIAN = {
    'Prf_Function': GAUSSIAN,
    'Param_Names': ['x0', 'y0', 'Sigma'],
    'Scaled_Param': [1, 1, 1],
    'SeedPar_Function': '@(V)[V(2:3);V(4)/(2*sqrt(2*log(2)))]',
    'R2_Threshold': 0.1,
}
# A subject HRF through SamSrf's own file route: Model.Hrf names an hrf_*.mat
# holding fP = [response latency, undershoot latency, ratio, scale] (written by
# prepare_cli_bundle.m). The name must be relative: SamSrf recognises the route
# from the first four characters, and loads it from the results directory.
# A numeric vector in model JSON does not work through the CLI: readstruct reads
# a flat list as a row and a nested list as a cell, and both fail upstream.
CUSTOM_HRF = 'hrf_custom'
# The pinned source transposes that route's HRF into a row, which the fitting
# loops take for one HRF per vertex; prepare.py --cli keeps it a column.
STAGED = ('SamSrf_defaults.json', f'{CUSTOM_HRF}.mat')

CASES = [
    {'id': 'prf_gaussian_lh_average', 'algorithm': 'prf', 'dataset': 'x001_lh', 'average': 1,
     'model': forward('x001_lh', 'aps_bars_vec')},
    {'id': 'prf_gaussian_lh_concatenate', 'algorithm': 'prf', 'dataset': 'x001_lh', 'average': 0,
     'model': forward('x001_lh', 'aps_bars6_vec')},
    {'id': 'prf_gaussian_rh', 'algorithm': 'prf', 'dataset': 'x001_rh', 'average': 1,
     'model': forward('x001_rh', 'aps_bars_vec')},
    {'id': 'prf_css_lh', 'algorithm': 'prf', 'dataset': 'x001_lh', 'average': 1,
     'model': {**forward('x001_lh', 'aps_bars_vec'), 'Compressive_Nonlinearity': True}},
    {'id': 'prf_custom_hrf_lh', 'algorithm': 'prf', 'dataset': 'x001_lh', 'average': 1,
     'model': {**forward('x001_lh', 'aps_bars_vec'), 'Hrf': CUSTOM_HRF}},
    {'id': 'rc_hull_lh', 'algorithm': 'rc', 'dataset': 'x001_lh', 'average': 1,
     'model': reverse_correlation()},
    {'id': 'rc_gaussian_lh', 'algorithm': 'rc', 'dataset': 'x001_lh', 'average': 1,
     'model': reverse_correlation(**RC_GAUSSIAN)},
    {'id': 'rc_custom_hrf_lh', 'algorithm': 'rc', 'dataset': 'x001_lh', 'average': 1,
     'model': reverse_correlation(Hrf=CUSTOM_HRF, Allow_Negative_Peaks=True)},
    {'id': 'cf_hull_lh', 'algorithm': 'cf', 'dataset': 'x001_lh', 'average': 1,
     'model': connective_field('x001_lh', 0)},
    {'id': 'cf_summary_lh', 'algorithm': 'cf', 'dataset': 'x001_lh', 'average': 1,
     'model': connective_field('x001_lh', -1)},
    {'id': 'cf_gaussian_lh', 'algorithm': 'cf', 'dataset': 'x001_lh', 'average': 1,
     'model': connective_field('x001_lh', 1)},
    {'id': 'cf_hull_smooth_global_lh', 'algorithm': 'cf', 'dataset': 'x001_lh', 'average': 1,
     'model': connective_field('x001_lh', 0, smoothing=1, correct=True)},
]


def argv(case, precision):
    dataset = case['dataset']
    hemisphere = DATASETS[dataset]['hemisphere']
    # SamSrfAnalysis lowercases the data wildcard, so the bundle stores lowercase names.
    return [
        case['algorithm'],
        f'{INPUT}/models/{case["id"]}_{precision}',
        f'{INPUT}/{dataset}/{hemisphere}_ubars*.gii',
        f'-outpath={RESULTS}',
        f'-roi={INPUT}/{dataset}/roi',
        f'-surf={INPUT}/{dataset}/surf',
        '-norm=1',
        f'-aver={case["average"]}',
    ]


def model(case, precision):
    result = {'Name': f'{case["id"]}_{precision}'}
    for key, value in case['model'].items():
        result[key] = value.replace('{precision}', precision) if isinstance(value, str) else value
    return result


def plan():
    runs = [{'id': f'{case["id"]}_{precision}', 'case': case['id'], 'precision': precision,
             'algorithm': case['algorithm'], 'dataset': case['dataset'],
             'argv': argv(case, precision), 'model': model(case, precision)}
            for case in CASES for precision in PRECISIONS]
    return {'version': 1, 'input': INPUT, 'resultsToken': RESULTS,
            'datasets': DATASETS, 'runs': runs}


def results_argv(run, results):
    return [value.replace(RESULTS, results) for value in run['argv']]


def write_models(plan_data, bundle):
    """Write each run's model after prepare_cli_bundle.m has made its inputs."""
    directory = Path(bundle) / 'models'
    directory.mkdir()
    for run in plan_data['runs']:
        # json writes the shortest repr that round-trips each double exactly.
        text = json.dumps(run['model'], indent=2, allow_nan=False) + '\n'
        (directory / f'{run["model"]["Name"]}.json').write_text(text)


def expected_staged_files(plan_data, bundle):
    """Return the exact per-run staged filenames and bytes derived from plan_data and bundle."""
    bundle = Path(bundle)
    defaults = json.loads((bundle / 'SamSrf_defaults.json').read_text())
    hrf_bytes = None
    staged = {}
    for run in plan_data['runs']:
        # The defaults loader reads the starting directory in the compiled
        # application; def_64bit selects the precision under test.
        content = {**defaults, 'def_64bit': run['precision'] == 'double'}
        files = {'SamSrf_defaults.json': (json.dumps(content, indent=2) + '\n').encode()}
        if run['model'].get('Hrf') == CUSTOM_HRF:
            if hrf_bytes is None:
                hrf_bytes = (bundle / f'{CUSTOM_HRF}.mat').read_bytes()
            files[f'{CUSTOM_HRF}.mat'] = hrf_bytes
        staged[run['id']] = files
    return staged


def expected_staged_hashes(plan_data, bundle):
    """Return {run_id: {filename: sha256}} for every run's expected staged files."""
    return {
        run_id: {name: hashlib.sha256(data).hexdigest() for name, data in sorted(files.items())}
        for run_id, files in expected_staged_files(plan_data, bundle).items()
    }


def staged_file_hashes(directory, run):
    """Hash a run directory's staged input files (SamSrf_defaults.json and optional hrf_custom.mat)."""
    directory = Path(directory)
    expected = ['SamSrf_defaults.json']
    if run['model'].get('Hrf') == CUSTOM_HRF:
        expected.append(f'{CUSTOM_HRF}.mat')
    elif (directory / f'{CUSTOM_HRF}.mat').exists() or (directory / f'{CUSTOM_HRF}.mat').is_symlink():
        raise ValueError(f'{run["id"]}: unexpected staged {CUSTOM_HRF}.mat')
    hashes = {}
    for name in sorted(expected):
        path = directory / name
        if path.is_symlink():
            raise ValueError(f'{run["id"]}: symbolic link is not allowed in staged inputs: {path}')
        if not path.is_file():
            raise ValueError(f'{run["id"]}: missing staged input {name}')
        hashes[name] = hashlib.sha256(path.read_bytes()).hexdigest()
    return hashes


def stage(plan_data, bundle, root):
    """Create one fresh directory per run with that run's defaults; never reuse one."""
    root = Path(root)
    root.mkdir(parents=True, exist_ok=False)
    for run_id, files in expected_staged_files(plan_data, bundle).items():
        directory = root / run_id
        directory.mkdir()
        for name, data in files.items():
            (directory / name).write_bytes(data)


def is_staged(directory):
    names = sorted(path.name for path in Path(directory).iterdir())
    return 'SamSrf_defaults.json' in names and set(names) <= set(STAGED)


def tree_hashes(root):
    root = Path(root)
    hashes = {}
    for path in sorted(root.rglob('*')):
        if path.is_symlink():
            raise ValueError(f'Symbolic links are not allowed in a pinned tree: {path}')
        if path.is_file():
            hashes[path.relative_to(root).as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()
    return hashes


def verify_inputs(plan_data, bundle, manifest_path, results_root):
    """Verify the bundle, receipts/inputs.json, per-run receipts and on-disk staged files."""
    expected_manifest = json.loads(Path(manifest_path).read_text())
    actual_bundle = tree_hashes(bundle)
    if actual_bundle != expected_manifest:
        raise ValueError('The bundle differs from its recorded SHA-256 hashes')
    expected_staged = expected_staged_hashes(plan_data, bundle)
    results_root = Path(results_root)
    receipts = results_root / 'receipts'
    inputs_file = receipts / 'inputs.json'
    if not inputs_file.is_file():
        raise ValueError(f'Missing input attestation receipt {inputs_file}')
    recorded = json.loads(inputs_file.read_text())
    if recorded.get('unchanged') is not True or recorded.get('sha256') != expected_manifest:
        raise ValueError('receipts/inputs.json does not attest the bundle manifest')
    if recorded.get('staged') != expected_staged:
        raise ValueError('receipts/inputs.json staged file hashes do not match the plan and bundle')
    for run in plan_data['runs']:
        run_id = run['id']
        actual_staged = staged_file_hashes(results_root / run_id, run)
        if actual_staged != expected_staged[run_id]:
            raise ValueError(f'{run_id}: on-disk staged inputs differ from the plan and bundle')
        receipt_path = receipts / f'{run_id}.json'
        if not receipt_path.is_file():
            raise ValueError(f'{run_id}: missing run receipt {receipt_path}')
        run_receipt = json.loads(receipt_path.read_text())
        if run_receipt.get('stagedInputs') != expected_staged[run_id]:
            raise ValueError(f'{run_id}: run receipt stagedInputs differs from the plan and bundle')
    return recorded


def main(arguments):
    if arguments[:1] == ['plan'] and len(arguments) == 2:
        Path(arguments[1]).write_text(json.dumps(plan(), indent=2) + '\n')
    elif arguments[:1] == ['models'] and len(arguments) == 3:
        write_models(json.loads(Path(arguments[1]).read_text()), arguments[2])
    elif arguments[:1] == ['stage'] and len(arguments) == 4:
        stage(json.loads(Path(arguments[1]).read_text()), arguments[2], arguments[3])
    elif arguments[:1] == ['hash'] and len(arguments) == 3:
        with Path(arguments[2]).open('x') as output:
            json.dump(tree_hashes(arguments[1]), output, indent=2)
            output.write('\n')
    elif arguments[:1] == ['verify'] and len(arguments) == 3:
        if tree_hashes(arguments[1]) != json.loads(Path(arguments[2]).read_text()):
            raise SystemExit('The bundle differs from its recorded SHA-256 hashes')
    elif arguments[:1] == ['verify-inputs'] and len(arguments) == 5:
        try:
            verify_inputs(json.loads(Path(arguments[1]).read_text()), arguments[2], arguments[3], arguments[4])
        except ValueError as error:
            raise SystemExit(str(error)) from error
    else:
        raise SystemExit(__doc__)


if __name__ == '__main__':
    main(sys.argv[1:])
