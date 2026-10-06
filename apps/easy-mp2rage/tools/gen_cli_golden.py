#!/usr/bin/env python3
"""
gen_cli_golden.py -- run the Python pipeline (mp2rage_t1.pipeline.run) on the phantom with each
option the easy-mp2rage command line exposes, and keep every file it writes as a golden NIfTI.

packages/easy-mp2rage/validation/cli-check.mjs compares a packaged command line against these.
They come from the Python implementation, not from the WASM core the command line runs, so they
check it independently. The phantom has no BIDS sidecars, so the acquisition values the
pipeline would read from them are supplied here; they match the values the check passes.

Run:  python tools/gen_cli_golden.py     (needs numpy, scipy, nibabel)
"""
from __future__ import annotations
import gzip
import json
import os
import shutil
import sys
import tempfile

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, REPO)

from mp2rage_t1 import denoise as D            # noqa: E402
from mp2rage_t1 import dicom_io as dio         # noqa: E402
from mp2rage_t1 import pipeline as P           # noqa: E402
import nibabel as nib                          # noqa: E402
import scipy                                   # noqa: E402

PHA = os.path.join(HERE, 'phantom')
GOLDEN = os.path.join(HERE, 'golden')
OUT = os.path.join(GOLDEN, 'cli')

INV_EFF = 0.96
MP = dict(B0=7.0, TR=4.3, TIs=(0.840, 2.370), FlipDegrees=(5.0, 6.0), NZslices=(64, 128),
          TRFLASH=0.007, inv_eff=INV_EFF)
SA = dict(TR=2.4, TRFLASH=0.005, TIs=(0.150, 1.500), FlipDegrees=(6.0, 6.0),
          NZslices=(24, 24), averageT1=1.5)

# Each case is one command-line run with UNI and INV2. "baseline" names the case it differs from
# by one option; cli-check.mjs requires the two goldens to differ, so the phantom exercises the
# option. A stated SA2RAGE flip angle of 12 degrees and a tfl reference angle of 40 degrees
# overestimate B1 enough that some brain voxels do not converge, which the fallback then fills.
CASES = {
    'sa2rage': dict(sa2rage=SA),
    'sa2rage-fa12': dict(sa2rage=dict(SA, FlipDegrees=(12.0, 12.0)), baseline='sa2rage'),
    'sa2rage-fa12-fallback': dict(sa2rage=dict(SA, FlipDegrees=(12.0, 12.0)), fallback_uncorrected=True,
                                  baseline='sa2rage-fa12'),
    'tfl': dict(b1_ref_angle=80.0),
    'tfl-reference-60': dict(b1_ref_angle=60.0, baseline='tfl'),
    'tfl-extend-fov': dict(b1_ref_angle=80.0, extend_fov=True, baseline='tfl'),
    'tfl-reference-40': dict(b1_ref_angle=40.0, baseline='tfl'),
    'tfl-reference-40-fallback': dict(b1_ref_angle=40.0, fallback_uncorrected=True,
                                      baseline='tfl-reference-40'),
}


def sa2rage_list(sa):
    return [sa['TR'], *sa['TIs'], *sa['FlipDegrees'], *sa['NZslices'], sa['TRFLASH'], sa['averageT1']]


def cli_args(case):
    if 'sa2rage' in case:
        args = ['--sa2rage-params', ','.join(f'{value:g}' for value in sa2rage_list(case['sa2rage']))]
    else:
        args = ['--reference-angle', f"{case['b1_ref_angle']:g}"]
    if case.get('extend_fov'):
        args.append('--extend-fov')
    if case.get('fallback_uncorrected'):
        args.append('--fallback-uncorrected')
    return args


# pipeline.run's output path -> the command line's file name
FILES = {
    't1map/phantom_T1map.nii.gz': 'T1map.nii.gz',
    'b1map/phantom_B1map.nii.gz': 'B1map.nii.gz',
    't1map/derivative_files/phantom_T1map_uncorrected.nii.gz': 'T1map_uncorrected.nii.gz',
    't1map/derivative_files/phantom_UNI_b1corrected.nii.gz': 'UNI_b1corrected.nii.gz',
}


def record(klass, name):
    return dict(path=os.path.join(PHA, name), kind='nifti', meta={}, asc={}, klass=klass,
                ti=0.0, fa=0.0, series=0, desc=klass)


def run_case(name, case):
    inputs = [record('uni', 'phantom_UNI.nii.gz'), record('inv2', 'phantom_INV2.nii.gz')]
    if 'sa2rage' in case:
        inputs.append(record('sa2rage', 'phantom_SA2RAGE.nii.gz'))
    dio.survey = lambda _paths: inputs
    dio.detect_b0 = lambda _by, _override=None: MP['B0']
    dio.subject_label = lambda _rec: 'phantom'
    dio.build_mp2rage_params = lambda *_a, **_k: dict(MP)
    dio.build_sa2rage_params = lambda *_a, **_k: dict(case.get('sa2rage', SA))
    work = tempfile.mkdtemp(prefix='easy-mp2rage-golden-')
    try:
        P.run([], work, inv_eff=INV_EFF,
              b1_map=None if 'sa2rage' in case else os.path.join(PHA, 'phantom_B1map_tfl.nii.gz'),
              b1_map_type='tfl', b1_ref_angle=case.get('b1_ref_angle', 80.0),
              fallback_uncorrected=case.get('fallback_uncorrected', False),
              extend_fov=case.get('extend_fov', False), work_dir=work, log=lambda _m: None)
        destination = os.path.join(OUT, name)
        os.makedirs(destination, exist_ok=True)
        for source, target in FILES.items():
            if 'sa2rage' in case and target == 'B1map.nii.gz':
                target = 'B1map_from_SA2RAGE.nii.gz'
            write_gz(nib.load(os.path.join(work, source)), os.path.join(destination, target))
    finally:
        shutil.rmtree(work)


def write_gz(image, path):
    # A fixed gzip header (no name, no mtime) keeps reruns byte-identical.
    data = image.to_bytes()
    with open(path, 'wb') as raw, gzip.GzipFile(filename='', mode='wb', fileobj=raw, mtime=0) as out:
        out.write(data)


def denoise_case(mf):
    inputs = {role: np.load(os.path.join(GOLDEN, f'u_rc_{role}.npy')) for role in ('uni', 'inv1', 'inv2')}
    return D.robust_combination(inputs['uni'], inputs['inv1'], inputs['inv2'], mf)


def main():
    if os.path.isdir(OUT):
        shutil.rmtree(OUT)
    os.makedirs(OUT)
    for name, case in CASES.items():
        run_case(name, case)
        print(f'  cli/{name}')
    # The denoising golden at the default strength is u_rc_out.npy; this adds a non-default one.
    np.save(os.path.join(OUT, 'denoise-regularization-2.npy'), denoise_case(2.0))
    print('  cli/denoise-regularization-2.npy')
    manifest = dict(numpy=np.__version__, scipy=scipy.__version__, nibabel=nib.__version__,
                    mp2rage=MP,
                    cases={name: dict(b1_source='sa2rage' if 'sa2rage' in case else 'tfl',
                                      args=cli_args(case), baseline=case.get('baseline'))
                           for name, case in CASES.items()})
    with open(os.path.join(OUT, 'manifest.json'), 'w') as f:
        json.dump(manifest, f, indent=2)
        f.write('\n')


if __name__ == '__main__':
    main()
