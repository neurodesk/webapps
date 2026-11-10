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


def stage(plan_data, bundle, root):
    """Create one fresh directory per run with that run's defaults; never reuse one."""
    bundle = Path(bundle)
    defaults = json.loads((bundle / 'SamSrf_defaults.json').read_text())
    root = Path(root)
    root.mkdir(parents=True, exist_ok=False)
    for run in plan_data['runs']:
        directory = root / run['id']
        directory.mkdir()
        # The defaults loader reads the starting directory in the compiled
        # application; def_64bit selects the precision under test.
        content = {**defaults, 'def_64bit': run['precision'] == 'double'}
        (directory / 'SamSrf_defaults.json').write_text(json.dumps(content, indent=2) + '\n')
        if run['model'].get('Hrf') == CUSTOM_HRF:
            name = f'{CUSTOM_HRF}.mat'
            (directory / name).write_bytes((bundle / name).read_bytes())


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
    else:
        raise SystemExit(__doc__)


if __name__ == '__main__':
    main(sys.argv[1:])
