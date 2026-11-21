#!/usr/bin/env python3
"""Package the native syncro command with its pinned tools (packages/syncro/tools.json) and run the release
check (packages/syncro/validation/package-check.mjs) on the extracted archive.

  package-syncro.py package TARGET [--local-tool NAME=PATH ...]

--local-tool replaces a pinned tool with a local binary; the archive is then named -local and is not a release
asset (it exists to check a platform whose tool has no published release yet).
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
CRATE = ROOT / 'exes/syncro'
PACKAGE = ROOT / 'packages/syncro'
VERSION = json.loads((ROOT / 'apps/syncro/package.json').read_text())['version']
MANIFEST = json.loads((PACKAGE / 'tools.json').read_text())
if os.environ.get('RUNNER_TEMP'):
    tempfile.tempdir = os.environ['RUNNER_TEMP']
CACHE = Path(os.environ.get('SYNCRO_TOOL_CACHE', Path(tempfile.gettempdir()) / 'syncro-tools'))

TARGETS = {'linux-x64': ('Linux', 'x86_64'), 'windows-x64': ('Windows', 'AMD64'),
           'macos-arm64': ('Darwin', 'arm64')}


def fetch(asset):
    """The asset's bytes on disk, downloaded once and checked against its pin."""
    path = CACHE / asset['sha256'] / asset['url'].rsplit('/', 1)[1]
    if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != asset['sha256']:
        path.parent.mkdir(parents=True, exist_ok=True)
        with urllib.request.urlopen(asset['url']) as response, open(path, 'wb') as out:
            shutil.copyfileobj(response, out)
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        if digest != asset['sha256']:
            path.unlink()
            raise ValueError(f"{asset['url']}: SHA-256 {digest} differs from its pin {asset['sha256']}")
    return path


def extract(archive, into):
    """Unpack a zip, tar.gz or macOS pkg (its payload) into `into`."""
    name = archive.name
    if name.endswith('.zip'):
        with zipfile.ZipFile(archive) as bundle:
            bundle.extractall(into)
            # extractall drops Unix modes; ANTs' zips record its executables as 0755.
            root = Path(into).resolve()
            for member in bundle.infolist():
                path = (root / member.filename).resolve()
                mode = member.external_attr >> 16 & 0o777
                if mode and not member.is_dir() and path.is_relative_to(root):
                    os.chmod(path, mode)
    elif name.endswith('.tar.gz'):
        with tarfile.open(archive) as bundle:
            bundle.extractall(into, filter='data')
    elif name.endswith('.pkg'):
        expanded = Path(tempfile.mkdtemp(prefix='syncro-pkg-'))
        shutil.rmtree(expanded)
        subprocess.run(['pkgutil', '--expand-full', str(archive), str(expanded)], check=True)
        for payload in expanded.glob('*/Payload'):
            shutil.copytree(payload, into, dirs_exist_ok=True, symlinks=True)
        shutil.rmtree(expanded)
    else:
        raise ValueError(f'{name}: unknown archive format')


def stage_tools(target, stage, local):
    """Copy each tool's declared files and licences into the stage; returns {tool: version}."""
    versions = {}
    for tool, spec in MANIFEST['tools'].items():
        exe = f'{tool}.exe' if target == 'windows-x64' else tool
        if tool in local:
            shutil.copy2(local[tool], stage / 'bin' / exe)
            versions[tool] = f'local {local[tool]}'
            continue
        if spec.get('blocked') or target not in spec['assets']:
            raise SystemExit(f"{tool}: no pinned {target} asset. {spec.get('blocked', '')}")
        asset = spec['assets'][target]
        with tempfile.TemporaryDirectory(prefix=f'syncro-{tool}-') as directory:
            unpacked = Path(directory)
            extract(fetch(asset), unpacked)
            for source, destination in asset['files'].items():
                shutil.copy2(unpacked / source, stage / destination)
                os.chmod(stage / destination, 0o755)
            notices = stage / 'licenses' / tool
            notices.mkdir(parents=True, exist_ok=True)
            for licence in spec['licenses']:
                found = next(unpacked.rglob(licence), None)
                if found is None and spec.get('licenseSource'):
                    found = ROOT / spec['licenseSource'] / licence
                if found is None or not found.is_file():
                    raise ValueError(f'{tool}: {licence} is missing from {asset["url"]}')
                shutil.copy2(found, notices / licence)
        versions[tool] = spec['version']
    return versions


def ants_path(target):
    """The pinned ANTs release's bin directory, for the release check only."""
    asset = MANIFEST['validation']['ants']['assets'][target]
    archive = fetch(asset)
    root = archive.parent / 'unpacked'
    if not root.is_dir():
        extract(archive, root)
    found = next(root.rglob('antsRegistration.exe' if target == 'windows-x64' else 'antsRegistration'))
    return found.parent


def package(target, local):
    expected_os, expected_arch = TARGETS[target]
    if (platform.system(), platform.machine()) != (expected_os, expected_arch):
        raise ValueError(f'{target} must be built and tested on {expected_os} {expected_arch}')
    executable = 'syncro.exe' if target == 'windows-x64' else 'syncro'
    build_env = os.environ.copy()
    if target == 'windows-x64':
        build_env['RUSTFLAGS'] = f"{build_env.get('RUSTFLAGS', '')} -C target-feature=+crt-static"
    subprocess.run(['cargo', 'build', '--locked', '--release', '-p', 'syncro'], cwd=CRATE, env=build_env, check=True)
    dist = CRATE / 'dist'
    dist.mkdir(exist_ok=True)
    name = f'syncro-{VERSION}-{target}' + ('-local' if local else '')
    with tempfile.TemporaryDirectory(prefix='syncro-package-') as directory:
        stage = Path(directory) / name
        for sub in ('bin', 'templates', 'licenses'):
            (stage / sub).mkdir(parents=True)
        shutil.copy2(CRATE / 'target/release' / executable, stage / executable)
        versions = stage_tools(target, stage, local)
        for filename in ('MNI152_T1_1mm_brain.nii.gz', 'FSL-LICENSE.txt'):
            shutil.copy2(PACKAGE / 'data' / filename, stage / 'templates' / filename)
        for filename in ('README.md', 'LICENSE', 'NOTICE'):
            shutil.copy2(PACKAGE / filename, stage / filename)
        (stage / 'tools.json').write_text(json.dumps(versions, indent=2) + '\n')
        if target == 'windows-x64':
            archive = dist / f'{name}.zip'
            with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as bundle:
                for item in sorted(stage.rglob('*')):
                    bundle.write(item, f'{name}/{item.relative_to(stage).as_posix()}')
        else:
            archive = dist / f'{name}.tar.gz'
            with tarfile.open(archive, 'w:gz') as bundle:
                bundle.add(stage, arcname=name)
        extracted = Path(directory) / 'extracted'
        extract(archive, extracted)
        # SYNCRO_CHECK_ANTSPATH: a local ANTs for a development check; CI runs the pinned release.
        env = dict(os.environ, ANTSPATH=os.environ.get('SYNCRO_CHECK_ANTSPATH') or str(ants_path(target)))
        env.pop('SYNCRO_HOME', None)
        check = subprocess.run(['node', str(PACKAGE / 'validation/package-check.mjs'), '--executable',
                                str(extracted / name / executable)], env=env, capture_output=True, text=True)
        report = check.stdout + check.stderr
        print(report)
        if check.returncode != 0:
            raise SystemExit(f'{archive.name}: the release check failed')
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    Path(f'{archive}.sha256').write_text(f'{digest}  {archive.name}\n', encoding='utf-8', newline='\n')
    # The Standalone catalog accepts a receipt only when it records the archive's digest and name.
    receipt = report.rstrip('\n') + f'\nsha256: {digest}  {archive.name}\n'
    Path(f'{archive}.validation.txt').write_text(receipt, encoding='utf-8', newline='\n')
    print(archive)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest='command', required=True)
    build = commands.add_parser('package')
    build.add_argument('target', choices=TARGETS)
    build.add_argument('--local-tool', action='append', default=[], metavar='NAME=PATH')
    args = parser.parse_args()
    local = dict(item.split('=', 1) for item in args.local_tool)
    unknown = set(local) - set(MANIFEST['tools'])
    if unknown:
        parser.error(f'unknown tool {", ".join(sorted(unknown))}')
    package(args.target, local)
