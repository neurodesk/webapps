#!/usr/bin/env python3
"""Pack a fitted_hrf recording for pinning (fitted-hrf-predictions.md).

Usage: python3 -I pack_fitted_hrf.py ARTIFACTS_DIR OUT_DIR OUT_ZIP RUN_ID HEAD_SHA

ARTIFACTS_DIR holds the downloaded `samsrf-matlab-<sha>-<label>-1-<attempt>`
artifacts of one samsrf-native run (one per runner label), each with
samsrf-matlab/ and samsrf-matlab-repeat/. OUT_DIR receives
<label>/first and <label>/repeat with the fitted-HRF files only, plus run.json:
every file's SHA-256 and byte count, the run, head and each host's CPU line.
The zip stores the files in sorted order with a fixed timestamp.
"""
import hashlib
import json
from pathlib import Path
import shutil
import sys
import zipfile

LABELS = ('ubuntu-22.04', 'ubuntu-24.04')
PROCESSES = {'first': 'samsrf-matlab', 'repeat': 'samsrf-matlab-repeat'}


def main():
    if len(sys.argv) != 6:
        raise SystemExit(__doc__)
    artifacts, out, archive, run, head = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3]), sys.argv[4], sys.argv[5]
    assert not out.exists(), f'{out} exists'
    hosts = {}
    for label in LABELS:
        found = sorted(artifacts.glob(f'samsrf-matlab-{head}-{label}-1-*'))
        assert len(found) == 1, f'{label}: expected one artifact, found {found}'
        for process, directory in PROCESSES.items():
            source = found[0] / directory
            target = out / label / process
            target.mkdir(parents=True)
            names = sorted(p.name for p in source.iterdir() if p.name == 'fitted-hrf.json' or p.suffix == '.f64')
            assert 'fitted-hrf.json' in names and len(names) > 1, f'{source}: no fitted-HRF recording'
            for name in names:
                shutil.copyfile(source / name, target / name)
        record = json.loads((out / label / 'first' / 'fitted-hrf.json').read_text())
        cpu = record['environment']['cpu']
        hosts[label] = {
            'model': next((line.split(':', 1)[1].strip() for line in cpu.splitlines() if 'Model name' in line), ''),
            'vendor': 'AMD' if 'AuthenticAMD' in cpu else 'Intel' if 'GenuineIntel' in cpu else 'unknown',
            'blas': record['environment']['observed']['blas'],
            'matlab': record['environment']['matlab'],
        }
    files = {}
    for path in sorted(p for p in out.rglob('*') if p.is_file()):
        data = path.read_bytes()
        files[str(path.relative_to(out))] = {'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)}
    run_json = {'githubRun': run, 'head': head, 'preregistration': 'fitted-hrf-predictions.md (dc41f25b)', 'hosts': hosts, 'files': files}
    (out / 'run.json').write_text(json.dumps(run_json, indent=1, sort_keys=True) + '\n')
    with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for path in sorted(p for p in out.rglob('*') if p.is_file()):
            info = zipfile.ZipInfo(str(path.relative_to(out)), date_time=(2026, 11, 14, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(info, path.read_bytes(), compresslevel=9)
    print(json.dumps({'files': len(files), 'hosts': hosts}, indent=1))


if __name__ == '__main__':
    main()
