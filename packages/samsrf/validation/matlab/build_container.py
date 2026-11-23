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
FROM_KEYWORD = re.compile(r'^\s*FROM(?:\s|$)', re.IGNORECASE)
COPY_ADD_KEYWORD = re.compile(r'^\s*(COPY|ADD)(?:\s|$)', re.IGNORECASE)
RUNTIME_IMAGE = 'samsrf-reference-runtime:r2023b'
APP_IMAGE = 'samsrf-reference:41ed1e96-r2023b'
RUNTIME_DOCKERFILE_CANDIDATES = (Path('runtime/Dockerfile.runtime'), Path('runtime/Dockerfile'))
RUNTIME_BASE_DOCKERFILE = Path('runtime/matlabruntimebase/Dockerfile.deps')


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


def sparse_cone_directories(source):
    """Return the allowed sparse-checkout cone directories when core.sparseCheckout is enabled,
    or None for a full checkout. Rejects non-cone sparse checkouts."""
    probe = subprocess.run(
        ['git', '-C', str(source), 'config', '--bool', 'core.sparseCheckout'],
        capture_output=True, text=True, check=False)
    if probe.returncode != 0 or probe.stdout.strip() != 'true':
        return None
    cone = subprocess.run(
        ['git', '-C', str(source), 'config', '--bool', 'core.sparseCheckoutCone'],
        capture_output=True, text=True, check=False)
    if cone.returncode != 0 or cone.stdout.strip() != 'true':
        raise ValueError(f'Sparse checkout in {source} must use cone mode')
    listed = subprocess.check_output(['git', '-C', str(source), 'sparse-checkout', 'list'], text=True).splitlines()
    return {entry.strip().strip('/') for entry in listed if entry.strip()}


def in_sparse_cone(rel, cone_dirs):
    """Return whether rel is permitted under Git's cone-mode sparse-checkout rules:
    root files, any file inside a selected directory, or an immediate file inside a
    strict ancestor of a selected directory."""
    parts = Path(rel).parts
    if len(parts) <= 1:
        return True
    for depth in range(1, len(parts)):
        if '/'.join(parts[:depth]) in cone_dirs:
            return True
    parent_prefix = '/'.join(parts[:-1]) + '/'
    return any(cone.startswith(parent_prefix) for cone in cone_dirs)


def tracked_present_files(source):
    """Return sorted relative POSIX paths of tracked, materialized files in a Git checkout.

    Excludes .git metadata, untracked files, and ignored files. Sparse-checkout
    entries (skip-worktree 'S') are omitted and must not exist on disk; when cone
    sparse-checkout is enabled, materialized paths outside the cone are rejected too.
    """
    source = Path(source)
    cone_dirs = sparse_cone_directories(source)
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
        if cone_dirs is not None and not in_sparse_cone(rel, cone_dirs):
            raise ValueError(f'Sparse-excluded path unexpectedly materialized in checkout: {rel}')
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


PARSER_DIRECTIVE = re.compile(r'^[ \t]*#[ \t]*([a-zA-Z0-9_-]+)[ \t]*=[ \t]*(.+)$')
KNOWN_DIRECTIVES = {'syntax', 'escape', 'check'}


def trailing_escape_count(text, escape):
    count = 0
    for ch in reversed(text):
        if ch == escape:
            count += 1
        else:
            break
    return count


def dockerfile_instructions(text):
    """Yield complete logical Dockerfile instructions, honoring BuildKit parser directives
    (syntax, escape, check) and line continuations."""
    escape = '\\'
    # Match Go bufio.ScanLines / BuildKit line splitting: split only on LF, stripping optional CR.
    lines = [line[:-1] if line.endswith('\r') else line for line in text.lstrip('\ufeff').split('\n')]
    index = 0
    seen_directives = set()
    while index < len(lines):
        match = PARSER_DIRECTIVE.match(lines[index])
        if not match:
            break
        key, value = match.group(1).lower(), match.group(2).strip(' \t')
        if key not in KNOWN_DIRECTIVES:
            break
        if key in seen_directives:
            raise ValueError(f'Duplicate Dockerfile parser directive: {key}')
        seen_directives.add(key)
        if key == 'escape':
            if value not in ('\\', '`'):
                raise ValueError(f'Unsupported Dockerfile escape directive: {value!r}')
            escape = value
        index += 1
    current = []
    for raw in lines[index:]:
        stripped = raw.strip()
        if not stripped or stripped.startswith('#'):
            # BuildKit skips blank lines and full-line comments (including Unicode
            # whitespace indentation) both between instructions and inside continuations.
            continue
        trimmed_right = raw.rstrip(' \t')
        if trailing_escape_count(trimmed_right, escape) % 2 == 1:
            current.append(trimmed_right[:-1])
        else:
            current.append(raw)
            instruction = ''.join(current).strip()
            if instruction:
                yield instruction
            current = []
    if current:
        instruction = ''.join(current).strip()
        if instruction:
            yield instruction


STAGE_ALIAS = re.compile(r'^[A-Za-z][A-Za-z0-9._-]*$')


def parse_copy_from_flag(instruction, path):
    """Return the `--from=<src>` value for a COPY instruction, or None if absent.

    Fails closed on ADD --from=, malformed/duplicate/quoted flags, `--`, or variable refs.
    """
    match = COPY_ADD_KEYWORD.match(instruction)
    if not match:
        return None
    keyword = match.group(1).upper()
    from_ref = None
    for token in instruction.split()[1:]:
        if not token.startswith('--'):
            break
        if token == '--' or '"' in token or "'" in token:
            raise ValueError(f'Unsupported {keyword} flag in generated Dockerfile {path}: {instruction}')
        lower = token.lower()
        if lower == '--from' or lower.startswith('--from='):
            if keyword != 'COPY':
                raise ValueError(f'Unsupported ADD --from= in generated Dockerfile {path}: {instruction}')
            if lower == '--from' or from_ref is not None:
                raise ValueError(f'Unsupported COPY --from= in generated Dockerfile {path}: {instruction}')
            value = token.split('=', 1)[1]
            if not value or '$' in value:
                raise ValueError(f'Unsupported COPY --from= in generated Dockerfile {path}: {instruction}')
            from_ref = value
    return from_ref


def parse_dockerfile_bases(dockerfile):
    """Parse generated Dockerfile FROM stages and resolve external base images.

    Returns (external_bases, final_base, copy_from_stages). Allows `COPY --from=<stage>`
    only when `<stage>` refers to a strictly earlier `FROM` stage in the same Dockerfile
    (by alias or 0-based index), whose external base image is recorded in `external_bases`.
    Fails closed on missing Dockerfiles, missing/unparseable FROM instructions, duplicate
    stage aliases, FROM scratch, variable-expanded FROM refs, ADD --from=, or COPY --from=
    referencing external images, self, or undeclared stages.
    """
    path = Path(dockerfile)
    if not path.is_file():
        raise ValueError(f'Missing generated Dockerfile: {path}')
    external_bases = []
    stage_bases = []
    earlier_aliases = {}
    all_aliases = set()
    current_alias = None
    final_base = None
    copy_from_stages = []
    # Decode raw bytes so Python universal newlines do not split on bare carriage returns.
    for instruction in dockerfile_instructions(path.read_bytes().decode('utf-8')):
        copy_from = parse_copy_from_flag(instruction, path)
        if copy_from is not None:
            if not stage_bases:
                raise ValueError(f'Unsupported COPY --from= before FROM in generated Dockerfile {path}: {instruction}')
            key = copy_from.lower()
            if key in earlier_aliases:
                stage_base = earlier_aliases[key]
            elif copy_from.isascii() and copy_from.isdigit() and int(copy_from) < len(stage_bases) - 1:
                stage_base = stage_bases[int(copy_from)]
            else:
                raise ValueError(f'Unsupported COPY/ADD --from= in generated Dockerfile {path}: {instruction}')
            entry = {'from': copy_from, 'stageBase': stage_base}
            if entry not in copy_from_stages:
                copy_from_stages.append(entry)
            continue
        if not FROM_KEYWORD.match(instruction):
            continue
        match = FROM_LINE.match(instruction)
        if not match:
            raise ValueError(f'Unsupported FROM instruction in generated Dockerfile {path}: {instruction}')
        if current_alias is not None:
            earlier_aliases[current_alias] = final_base
            current_alias = None
        ref, alias = match.group(1), match.group(2)
        if '$' in ref:
            raise ValueError(f'Unsupported variable FROM reference in generated Dockerfile {path}: {instruction}')
        if ref.lower() == 'scratch':
            raise ValueError(f'Unsupported FROM scratch in generated Dockerfile: {path}')
        if ref.lower() in earlier_aliases:
            resolved_base = earlier_aliases[ref.lower()]
        else:
            resolved_base = ref
            if ref not in external_bases:
                external_bases.append(ref)
        stage_bases.append(resolved_base)
        final_base = resolved_base
        if alias:
            if not STAGE_ALIAS.match(alias):
                raise ValueError(f'Invalid stage alias in generated Dockerfile {path}: {alias}')
            alias_key = alias.lower()
            if alias_key in all_aliases:
                raise ValueError(f'Duplicate stage alias in generated Dockerfile {path}: {alias}')
            all_aliases.add(alias_key)
            current_alias = alias_key
    if final_base is None:
        raise ValueError(f'Generated Dockerfile declares no FROM base image: {path}')
    return external_bases, final_base, copy_from_stages


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


def resolve_runtime_dockerfile(output):
    """Locate the generated runtime Dockerfile (`runtime/Dockerfile.runtime` in MATLAB
    R2023b U11, or `runtime/Dockerfile`), failing closed if both or neither exist."""
    present = [rel for rel in RUNTIME_DOCKERFILE_CANDIDATES if (output / rel).is_file()]
    if len(present) > 1:
        names = ', '.join(str(rel) for rel in present)
        raise ValueError(f'Ambiguous generated runtime Dockerfiles in {output}: {names}')
    if not present:
        raise ValueError(f'Missing generated Dockerfile: {output / RUNTIME_DOCKERFILE_CANDIDATES[0]}')
    return present[0]


def record_base_images(output, runtime_image=RUNTIME_IMAGE, app_image=APP_IMAGE, inspector=None):
    """Record and fail-closed verify generated Dockerfile FROM bases and layer lineage."""
    output = Path(output)
    inspect = inspector or inspect_docker_image
    dockerfiles = {}
    dockerfile_paths = {}
    final_bases = {}
    copy_from_stages = {}
    dockerfile_sha256 = {}
    resolved = {}

    def lookup(ref):
        if ref not in resolved:
            resolved[ref] = validate_image_metadata(ref, inspect(ref))
        return resolved[ref]

    def parse_entry(label, relative):
        path = output / relative
        refs, final_base, copy_from = parse_dockerfile_bases(path)
        dockerfiles[label] = refs
        dockerfile_paths[label] = relative.as_posix()
        final_bases[label] = final_base
        if copy_from:
            copy_from_stages[label] = copy_from
        dockerfile_sha256[label] = hashlib.sha256(path.read_bytes()).hexdigest()
        for ref in refs:
            lookup(ref)

    runtime_rel = resolve_runtime_dockerfile(output)
    parse_entry('runtime', runtime_rel)
    parse_entry('container', Path('container/Dockerfile'))

    runtime_base_ref = final_bases['runtime']
    deps_path = output / RUNTIME_BASE_DOCKERFILE
    if deps_path.is_file() or runtime_base_ref.startswith('matlabruntimebase/'):
        parse_entry('runtimeBase', RUNTIME_BASE_DOCKERFILE)
        deps_base_ref = final_bases['runtimeBase']
        require_layer_prefix(deps_base_ref, resolved[deps_base_ref], runtime_base_ref, resolved[runtime_base_ref])

    runtime_info = lookup(runtime_image)
    app_info = lookup(app_image)
    container_base_ref = final_bases['container']
    require_layer_prefix(runtime_base_ref, resolved[runtime_base_ref], runtime_image, runtime_info)
    if resolved[container_base_ref]['id'] != runtime_info['id']:
        raise ValueError(
            f'Container Dockerfile base {container_base_ref} ({resolved[container_base_ref]["id"]}) '
            f'does not match built runtime image {runtime_image} ({runtime_info["id"]})')
    require_layer_prefix(runtime_image, runtime_info, app_image, app_info)

    record = {
        'dockerfiles': dockerfiles,
        'dockerfilePaths': dockerfile_paths,
        'finalBases': final_bases,
        'copyFromStages': copy_from_stages,
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
