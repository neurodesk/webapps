#!/usr/bin/env python3
"""Build the version-matched Runtime reference on a licensed Compiler host.

This is separate from recording references in public CI, which needs no Compiler.
The build is local only: this script does not publish an image or a release.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

from prepare import SOURCE, repairs, source_record

FROM_LINE = re.compile(r'^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+\S+)?\s*$', re.IGNORECASE)


def git(directory, *args):
    return subprocess.check_output(['git', '-C', str(directory), *args], text=True).strip()


def verify_source(source, spm):
    if git(source, 'rev-parse', 'HEAD') != SOURCE['commit']:
        raise ValueError('Wrong SamSrf commit')
    modified = git(source, 'diff', '--name-only', 'HEAD').splitlines()
    # The compiled reference is the SamSrfAnalysis CLI, so it carries the CLI set.
    declared = repairs(cli=True)
    if sorted(modified) != sorted({name for name, _, _ in declared}):
        raise ValueError('Run prepare.py --cli; only its declared repairs may be present')
    if git(source, 'ls-files', '--others', '--exclude-standard'):
        raise ValueError('Untracked files in the reference source')
    files = []
    for name, before, after in declared:
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
    return {**source_record(cli=True), 'files': files}


def stage_clean_tree(source, destination):
    """Copy a verified checkout without .git metadata or symlinks so MATLAB Compiler
    cannot embed repository metadata into the standalone archive."""
    source = Path(source)
    destination = Path(destination)
    if destination.exists():
        raise ValueError(f'Clean staging directory already exists: {destination}')
    for entry in sorted(source.rglob('*')):
        if '.git' in entry.relative_to(source).parts:
            continue
        if entry.is_symlink():
            raise ValueError(f'Symbolic links are not allowed in clean staging tree: {entry}')
    shutil.copytree(source, destination, symlinks=True, ignore=shutil.ignore_patterns('.git'))
    staged_hashes = {}
    for path in sorted(destination.rglob('*')):
        if path.name == '.git' or '.git' in path.parts:
            raise ValueError(f'Unexpected .git entry in clean staging tree: {path}')
        if path.is_symlink():
            raise ValueError(f'Symbolic links are not allowed in clean staging tree: {path}')
        if path.is_file():
            rel = path.relative_to(destination).as_posix()
            actual = hashlib.sha256(path.read_bytes()).hexdigest()
            expected = hashlib.sha256((source / rel).read_bytes()).hexdigest()
            if actual != expected:
                raise ValueError(f'Staged file differs from verified source: {rel}')
            staged_hashes[rel] = actual
    return staged_hashes


def parse_dockerfile_bases(dockerfile):
    """Return every FROM image reference declared in a generated Dockerfile."""
    path = Path(dockerfile)
    if not path.is_file():
        return []
    bases = []
    for line in path.read_text().splitlines():
        match = FROM_LINE.match(line)
        if match:
            bases.append(match.group(1))
    return bases


def record_base_images(output, inspector=None):
    """Record the FROM base references of MATLAB Compiler's generated Dockerfiles and
    their resolved local image IDs/digests when available."""
    output = Path(output)
    dockerfiles = {}
    resolved = {}
    for label, relative in (('runtime', Path('runtime/Dockerfile')), ('container', Path('container/Dockerfile'))):
        refs = parse_dockerfile_bases(output / relative)
        dockerfiles[label] = refs
        for ref in refs:
            if ref in resolved:
                continue
            if inspector is not None:
                resolved[ref] = inspector(ref)
            else:
                completed = subprocess.run(
                    ['docker', 'image', 'inspect', ref], capture_output=True, text=True, check=False)
                if completed.returncode == 0:
                    data = json.loads(completed.stdout)[0]
                    resolved[ref] = {'id': data.get('Id'), 'repoDigests': data.get('RepoDigests', [])}
                else:
                    resolved[ref] = None
    record = {'dockerfiles': dockerfiles, 'resolved': resolved}
    (output / 'base-images.json').write_text(json.dumps(record, indent=2) + '\n')
    return record


def main(source, spm, output):
    provenance = verify_source(source, spm)
    output.mkdir(parents=True, exist_ok=False)
    staged_root = output / 'staged'
    staged_samsrf = staged_root / 'samsrf'
    staged_spm = staged_root / 'spm'
    samsrf_hashes = stage_clean_tree(source, staged_samsrf)
    spm_hashes = stage_clean_tree(spm, staged_spm)
    provenance['staged'] = {
        'gitExcluded': True,
        'samsrfFiles': len(samsrf_hashes),
        'spmFiles': len(spm_hashes),
    }
    (output / 'source.json').write_text(json.dumps(provenance, indent=2) + '\n')
    # When running inside a builder container with output bind-mounted at a canonical
    # path (e.g. /build), pass those container-canonical paths so host work paths are
    # not embedded into the compiled binary.
    canonical = os.environ.get('SAMSRF_CANONICAL_BUILD_DIR')
    if canonical:
        matlab_source = f'{canonical}/staged/samsrf'
        matlab_spm = f'{canonical}/staged/spm'
        matlab_output = canonical
    else:
        matlab_source = str(staged_samsrf)
        matlab_spm = str(staged_spm)
        matlab_output = str(output)
    # MATLAB string escaping, passed as one argv element rather than shell code.
    quote = lambda value: "'" + str(value).replace("'", "''") + "'"
    recorder = Path(__file__).resolve().parent
    command = f'addpath({quote(recorder)}); build_container({quote(matlab_source)},{quote(matlab_spm)},{quote(matlab_output)})'
    # A batch licensing token is honoured by setup-matlab's matlab-batch launcher,
    # not by `matlab -batch`; the CI build selects it with SAMSRF_MATLAB_BATCH.
    launcher = os.environ.get('SAMSRF_MATLAB_BATCH')
    argv = [launcher, command] if launcher else ['matlab', '-batch', command]
    subprocess.run(argv, check=True, env={**os.environ, 'MKL_CBWR': SOURCE['mklCbwr']})
    record_base_images(output)
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
