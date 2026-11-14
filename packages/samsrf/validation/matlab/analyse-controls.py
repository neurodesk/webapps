#!/usr/bin/env python3
"""Check the pinned MKL controls receipts (controls-reference.json).

Usage: python3 -I analyse-controls.py CONTROLS_DIR KERNELS_DIR [REPORT_JSON]

CONTROLS_DIR is the extracted controls recording; KERNELS_DIR the extracted
qr-kernels-reference.json recording, whose AMD (ubuntu-22.04-1) and Intel
(ubuntu-22.04-3) gemv trees the receipts' trees are compared with.

It fails unless:
- every file named in run.json is present with its SHA-256, and no other file is;
- all six jobs (two runner labels x three requests) hold a first and a
  repeat process, each with its receipt, partial receipt and four probes;
- each process ran R2023b Update 11, saw its job's requested environment
  except MKL_NUM_THREADS (MATLAB's getenv never returned it: the workflow set it,
  and it was absent in all twelve processes), and ended with
  maxNumCompThreads 1;
- the three receipts of a process (at start, after maxNumCompThreads(1), after
  a BLAS call) are identical, and the repeat equals the first process;
- each process's dgemv and sgemv trees equal the pinned trees of its CPU
  vendor;
- the observed controls are the ones README.md states (OBSERVED below).
"""
import hashlib
import json
from pathlib import Path
import struct
import sys

REQUESTS = {
    'documented': {'MKL_CBWR': 'COMPATIBLE', 'MKL_NUM_THREADS': '1', 'OMP_NUM_THREADS': '1', 'MKL_DYNAMIC': 'FALSE', 'OMP_DYNAMIC': 'FALSE'},
    'none': {'MKL_CBWR': '', 'MKL_NUM_THREADS': '', 'OMP_NUM_THREADS': '', 'MKL_DYNAMIC': '', 'OMP_DYNAMIC': ''},
    'contrast': {'MKL_CBWR': 'AVX2', 'MKL_NUM_THREADS': '4', 'OMP_NUM_THREADS': '4', 'MKL_DYNAMIC': 'TRUE', 'OMP_DYNAMIC': 'TRUE'},
}
LABELS = ('ubuntu-22.04', 'ubuntu-24.04')
CONTROLS = ('cbwrBranch', 'cbwrAutoBranch', 'mklMaxThreads', 'mklDynamic', 'ompMaxThreads', 'ompDynamic', 'version')
PROBES = ('probe_double_m64', 'probe_double_m250', 'probe_single_m64', 'probe_single_m250')
# oneMKL 2021 mkl_service.h: MKL_CBWR_AUTO 2, MKL_CBWR_COMPATIBLE 3, MKL_CBWR_AVX2 10, MKL_CBWR_AVX512_E1 14.
BRANCH = {'AMD': 2, 'Intel': 14}
MKL_VERSION = 'Intel(R) oneAPI Math Kernel Library Version 2021.3-Product Build 20220428 for Intel(R) 64 architecture applications'


def observed(vendor, request):
    """What the recording showed, per CPU vendor and request."""
    return {
        'cbwrBranch': (BRANCH[vendor], 'MKL_CBWR_Get'),
        'cbwrAutoBranch': (BRANCH[vendor], 'MKL_CBWR_Get_Auto_Branch'),
        # Neither MKL's C nor its Fortran thread functions resolve in MATLAB's process.
        'mklMaxThreads': (None, ''),
        'mklDynamic': (None, ''),
        'ompMaxThreads': (1, 'omp_get_max_threads'),
        'ompDynamic': (1 if request == 'contrast' else 0, 'omp_get_dynamic'),
    }


def doubles(path):
    data = path.read_bytes()
    return struct.unpack(f'<{len(data) // 8}d', data)


def pinned_trees(kernels):
    trees = {}
    hosts = json.loads((kernels / 'hosts.json').read_text())
    for vendor, host in (('AMD', 'ubuntu-22.04-1'), ('Intel', 'ubuntu-22.04-3')):
        assert hosts[host]['cpu'].startswith(vendor), f'{host} is not the pinned {vendor} kernel host'
        metadata = json.loads((kernels / host / 'kernels.json').read_text())
        for probe in metadata['probes']:
            if probe['alignA'] == 0 and probe['alignX'] == 0 and probe['part'] == 0 and probe['class'] in ('double', 'single') and probe['length'] in (64, 250):
                data = (kernels / host / probe['results']['file']).read_bytes()
                values = struct.unpack(f'<{len(data) // 2}h', data) if probe['results']['file'].endswith('.i16') else struct.unpack(f'<{len(data) // 8}d', data)
                trees[(vendor, f"probe_{probe['class']}_m{probe['length']}")] = [float(v) for v in values]
    assert len(trees) == 8, 'pinned AMD and Intel trees'
    return trees


def main():
    if len(sys.argv) not in (3, 4):
        raise SystemExit(__doc__)
    root, kernels = Path(sys.argv[1]), Path(sys.argv[2])
    run = json.loads((root / 'run.json').read_text())
    present = sorted(str(p.relative_to(root)) for p in root.rglob('*') if p.is_file() and p.name != 'run.json')
    assert present == sorted(run['files']), 'the recording holds exactly the files run.json lists'
    for name, digest in run['files'].items():
        assert hashlib.sha256((root / name).read_bytes()).hexdigest() == digest, name
    trees = pinned_trees(kernels)
    report = []
    for label in LABELS:
        for request, environment in REQUESTS.items():
            job = root / f'{label}-{request}'
            receipts = []
            for process in ('first', 'repeat'):
                directory = job / process
                names = sorted(p.name for p in directory.iterdir())
                assert names == sorted(['controls.json', 'controls-partial.json'] + [f'{p}.f64' for p in PROBES]), f'{directory}: files'
                r = json.loads((directory / 'controls.json').read_text())
                visible = {**environment, 'MKL_NUM_THREADS': ''}
                assert r['request'] == request and r['requested'] == visible, f'{directory}: environment visible in MATLAB {r["requested"]}'
                assert r['matlab'].startswith('23.2.0.3097123'), f'{directory}: MATLAB'
                assert r['maxNumCompThreadsAfter'] == 1, f'{directory}: thread limit'
                vendor = 'AMD' if 'AuthenticAMD' in r['cpu'] else 'Intel' if 'GenuineIntel' in r['cpu'] else None
                assert vendor, f'{directory}: CPU vendor'
                stages = [r['receipts'][s] for s in ('atStart', 'afterThreadLimit', 'afterBlasCall')]
                assert stages[0] == stages[1] == stages[2], f'{directory}: controls changed within the process'
                stage = stages[0]
                assert sorted(stage) == sorted(CONTROLS), f'{directory}: controls read'
                assert stage['version']['value'] == MKL_VERSION, f'{directory}: MKL version'
                for control, (value, symbol) in observed(vendor, request).items():
                    assert (stage[control]['value'], stage[control]['symbol']) == (value, symbol), f'{directory}: {control} {stage[control]} != {(value, symbol)}'
                expected_branch = 'CNR branch auto' if vendor == 'AMD' else 'CNR branch AVX512_E1'
                assert r['blas'].endswith(f'({expected_branch})'), f'{directory}: version -blas'
                probe_trees = {}
                for probe in PROBES:
                    values = [float(v) for v in doubles(directory / f'{probe}.f64')]
                    assert values == trees[(vendor, probe)], f'{directory}: {probe} is not the pinned {vendor} tree'
                    probe_trees[probe] = values
                cpu = next((line.split(':', 1)[1].strip() for line in r['cpu'].splitlines() if 'Model name' in line), '')
                receipts.append((vendor, cpu, stage, r['blas'], probe_trees))
            assert receipts[0] == receipts[1], f'{job}: the repeat process differs'
            vendor, cpu, stage = receipts[0][:3]
            report.append({'job': f'{label}-{request}', 'vendor': vendor, 'cpu': cpu,
                           'controls': {k: v['value'] for k, v in stage.items() if k != 'version'}})
            print(f"{label}-{request}: {cpu} ({vendor}); branch {stage['cbwrBranch']['value']}, auto {stage['cbwrAutoBranch']['value']}, "
                  f"MKL threads unavailable, OpenMP threads {stage['ompMaxThreads']['value']}, dynamic {stage['ompDynamic']['value']}; repeat identical")
    if len(sys.argv) == 4:
        Path(sys.argv[3]).write_text(json.dumps(report, indent=1) + '\n')


if __name__ == '__main__':
    main()
