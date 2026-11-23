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

FROM_LINE = re.compile(r'^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?\s*$', re.IGNORECASE)
RUNTIME_IMAGE = 'samsrf-reference-runtime:r2023b'
APP_IMAGE = 'samsrf-reference:41ed1e96-r2023b'


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


def tracked_present_files(source):
    """Return sorted relative POSIX paths of tracked, materialized files in a Git checkout.

    Excludes .git metadata, untracked files, and ignored files. Sparse-checkout
    entries (skip-worktree 'S') are omitted and must not exist on disk.
    """
    source = Path(source)
    raw = subprocess.check_output(['git', '-C', str(source), 'ls-files', '-v', '-z'])
    present = []
    for entry in raw.split(b'\0'):
        if not entry:
            continue
        decoded = entry.decode('utf-8')
        if len(decoded) < 3 or decoded[1] != ' ':
            raise ValueError(f'Unexpected git ls-files entry: {decoded!r}')
        tag, rel = decoded[0], decoded[2:]
        if tag == 'S':
            candidate = source / rel
            if candidate.exists() or candidate.is_symlink():
                raise ValueError(f'Sparse-excluded path unexpectedly exists on disk: {rel}')
            continue
        if tag != 'H':
            raise ValueError(f'Unexpected git index state {tag!r} for {rel}')
        if '.git' in Path(rel).parts:
            raise ValueError(f'Unexpected .git entry in tracked tree: {rel}')
        present.append(rel)
    return sorted(present)


def stage_clean_tree(source, destination):
    """Copy only tracked, materialized files from a verified checkout without .git
    metadata, ignored files, or symlinks."""
    source = Path(source)
    destination = Path(destination)
    if destination.exists():
        raise ValueError(f'Clean staging directory already exists: {destination}')
    tracked = tracked_present_files(source)
    if not tracked:
        raise ValueError(f'No tracked files found in {source}')
    destination.mkdir(parents=True, exist_ok=False)
    staged_hashes = {}
    for rel in tracked:
        src_path = source / rel
        if src_path.is_symlink():
            raise ValueError(f'Symbolic links are not allowed in clean staging tree: {src_path}')
        if not src_path.is_file():
            raise ValueError(f'Tracked source path is not a regular file: {src_path}')
        dst_path = destination / rel
        dst_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src_path, dst_path)
        actual = hashlib.sha256(dst_path.read_bytes()).hexdigest()
        expected = hashlib.sha256(src_path.read_bytes()).hexdigest()
        if actual != expected:
            raise ValueError(f'Staged file differs from verified source: {rel}')
        staged_hashes[rel] = actual
    for path in sorted(destination.rglob('*')):
        if path.name == '.git' or '.git' in path.parts:
            raise ValueError(f'Unexpected .git entry in clean staging tree: {path}')
        if path.is_symlink():
            raise ValueError(f'Symbolic links are not allowed in clean staging tree: {path}')
    return staged_hashes


def parse_dockerfile_bases(dockerfile):
    """Return every external FROM image reference declared in a generated Dockerfile.

    Requires the Dockerfile to exist and declare at least one external FROM base.
    Multi-stage aliases defined earlier in the same Dockerfile are ignored as external bases.
    """
    path = Path(dockerfile)
    if not path.is_file():
        raise ValueError(f'Missing generated Dockerfile: {path}')
    stages = []
    aliases = set()
    for line in path.read_text().splitlines():
        match = FROM_LINE.match(line)
        if not match:
            continue
        ref, alias = match.group(1), match.group(2)
        if ref.lower() not in aliases:
            stages.append(ref)
        if alias:
            aliases.add(alias.lower())
    if not stages:
        raise ValueError(f'Generated Dockerfile declares no FROM base image: {path}')
    return stages


def inspect_docker_image(ref):
    completed = subprocess.run(
        ['docker', 'image', 'inspect', ref], capture_output=True, text=True, check=False)
    if completed.returncode != 0:
        raise ValueError(f'Cannot inspect Docker image {ref}: {completed.stderr.strip()}')
    entries = json.loads(completed.stdout)
    if not entries:
        raise ValueError(f'Docker returned empty inspect output for {ref}')
    data = entries[0]
    return {
        'id': data.get('Id'),
        'repoDigests': data.get('RepoDigests', []),
        'layers': (data.get('RootFS') or {}).get('Layers') or [],
    }


def validate_image_metadata(ref, info):
    if not isinstance(info, dict) or not info.get('id'):
        raise ValueError(f'Missing Docker image ID for {ref}')
    layers = info.get('layers')
    if not isinstance(layers, list) or not layers:
        raise ValueError(f'Missing RootFS layers for {ref}')
    return {
        'id': info['id'],
        'repoDigests': list(info.get('repoDigests') or []),
        'layers': list(layers),
    }


def require_layer_prefix(parent_ref, parent, child_ref, child):
    parent_layers = parent['layers']
    child_layers = child['layers']
    if len(child_layers) < len(parent_layers) or child_layers[:len(parent_layers)] != parent_layers:
        raise ValueError(
            f'Base image {parent_ref} ({parent["id"]}) layers are not a prefix of '
            f'{child_ref} ({child["id"]}); tag may be stale or mismatched')


def record_base_images(output, runtime_image=RUNTIME_IMAGE, app_image=APP_IMAGE, inspector=None):
    """Record and fail-closed verify generated Dockerfile FROM bases and layer lineage."""
    output = Path(output)
    inspect = inspector or inspect_docker_image
    dockerfiles = {}
    dockerfile_sha256 = {}
    resolved = {}

    def lookup(ref):
        if ref not in resolved:
            resolved[ref] = validate_image_metadata(ref, inspect(ref))
        return resolved[ref]

    for label, relative in (('runtime', Path('runtime/Dockerfile')), ('container', Path('container/Dockerfile'))):
        path = output / relative
        refs = parse_dockerfile_bases(path)
        dockerfiles[label] = refs
        dockerfile_sha256[label] = hashlib.sha256(path.read_bytes()).hexdigest()
        for ref in refs:
            lookup(ref)

    runtime_info = lookup(runtime_image)
    app_info = lookup(app_image)
    runtime_base_ref = dockerfiles['runtime'][-1]
    container_base_ref = dockerfiles['container'][-1]
    require_layer_prefix(runtime_base_ref, resolved[runtime_base_ref], runtime_image, runtime_info)
    if resolved[container_base_ref]['id'] != runtime_info['id']:
        raise ValueError(
            f'Container Dockerfile base {container_base_ref} ({resolved[container_base_ref]["id"]}) '
            f'does not match built runtime image {runtime_image} ({runtime_info["id"]})')
    require_layer_prefix(runtime_image, runtime_info, app_image, app_info)

    record = {
        'dockerfiles': dockerfiles,
        'dockerfileSha256': dockerfile_sha256,
        'resolved': resolved,
        'lineageVerified': True,
    }
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
