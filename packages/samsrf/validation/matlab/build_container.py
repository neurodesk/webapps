#!/usr/bin/env python3
"""Build the version-matched Runtime reference on a licensed Compiler host.

This is separate from recording references in public CI, which needs no Compiler.
The build is local only: this script does not publish an image or a release.
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

from prepare import REPAIRS, SOURCE


def git(directory, *args):
    return subprocess.check_output(['git', '-C', str(directory), *args], text=True).strip()


def verify_source(source, spm):
    if git(source, 'rev-parse', 'HEAD') != SOURCE['commit']:
        raise ValueError('Wrong SamSrf commit')
    modified = git(source, 'diff', '--name-only', 'HEAD').splitlines()
    if sorted(modified) != sorted(name for name, _, _ in REPAIRS):
        raise ValueError('Run prepare.py; only its declared repairs may be present')
    if git(source, 'ls-files', '--others', '--exclude-standard'):
        raise ValueError('Untracked files in the reference source')
    files = []
    for name, before, after in REPAIRS:
        original = subprocess.check_output(['git', '-C', str(source), 'show', f'HEAD:{name}'])
        if original.decode().count(before) != 1:
            raise ValueError(f'Unexpected repair site in {name}')
        expected = original.decode().replace(before, after).encode()
        if (source / name).read_bytes() != expected:
            raise ValueError(f'Unexpected source changes in {name}')
        files.append({'path': name,
                      'originalSha256': hashlib.sha256(original).hexdigest(),
                      'patchedSha256': hashlib.sha256(expected).hexdigest()})
    if git(spm, 'rev-parse', 'HEAD') != SOURCE['spm']['commit'] or git(spm, 'status', '--porcelain'):
        raise ValueError('SPM must be the clean pinned checkout')
    return {**SOURCE, 'files': files}


def main(source, spm, output):
    provenance = verify_source(source, spm)
    output.mkdir(parents=True, exist_ok=False)
    (output / 'source.json').write_text(json.dumps(provenance, indent=2) + '\n')
    # MATLAB string escaping, passed as one argv element rather than shell code.
    quote = lambda value: "'" + str(value).replace("'", "''") + "'"
    recorder = Path(__file__).resolve().parent
    command = f'addpath({quote(recorder)}); build_container({quote(source)},{quote(spm)},{quote(output)})'
    # A batch licensing token is honoured by setup-matlab's matlab-batch launcher,
    # not by `matlab -batch`; the CI build selects it with SAMSRF_MATLAB_BATCH.
    launcher = os.environ.get('SAMSRF_MATLAB_BATCH')
    argv = [launcher, command] if launcher else ['matlab', '-batch', command]
    subprocess.run(argv, check=True, env={**os.environ, 'MKL_CBWR': SOURCE['mklCbwr']})
    image = json.loads(subprocess.check_output([
        'docker', 'image', 'inspect', 'samsrf-reference:41ed1e96-r2023b']))[0]
    (output / 'image.json').write_text(json.dumps({
        'id': image['Id'], 'repoDigests': image['RepoDigests'],
        'created': image['Created'],
    }, indent=2) + '\n')


if __name__ == '__main__':
    if len(sys.argv) != 4:
        raise SystemExit('Usage: build_container.py PREPARED_SAMSRF PINNED_SPM NEW_OUTPUT')
    main(*(Path(value).resolve() for value in sys.argv[1:]))
