#!/usr/bin/env python3
"""Package Greedy and verify the extracted executable on a generated NIfTI."""
import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import struct
import subprocess
import sys
import tarfile
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts/lib'))
import windows_signing

CRATE = ROOT / 'exes/greedy'
VERSION = json.loads((ROOT / 'apps/greedy/package.json').read_text())['version']
if os.environ.get('RUNNER_TEMP'):
    tempfile.tempdir = os.environ['RUNNER_TEMP']

TARGETS = {'linux-x64': ('Linux', 'x86_64'), 'windows-x64': ('Windows', 'AMD64'),
           'macos-arm64': ('Darwin', 'arm64')}


def verify(executable, node_cli=False):
    executable = Path(executable).resolve()
    command = ['node', str(executable)] if node_cli else [str(executable)]
    version = subprocess.check_output([*command, '--version'], text=True).strip()
    if version != f'greedy-rs {VERSION}':
        raise ValueError(f'Unexpected executable version: {version}')
    with tempfile.TemporaryDirectory(prefix='greedy-offline-') as directory:
        work = Path(directory)
        data = bytearray(352 + 64 * 4)
        struct.pack_into('<i', data, 0, 348)
        struct.pack_into('<8h', data, 40, 3, 4, 4, 4, 1, 1, 1, 1)
        struct.pack_into('<2h', data, 70, 16, 32)
        struct.pack_into('<8f', data, 76, 1, 1, 1, 1, 1, 1, 1, 1)
        struct.pack_into('<f', data, 108, 352)
        struct.pack_into('<h', data, 254, 1)
        struct.pack_into('<12f', data, 280, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0)
        data[344:348] = b'n+1\x00'
        struct.pack_into('<64f', data, 352, *range(64))
        (work / 'input.nii.gz').write_bytes(gzip.compress(data))
        (work / 'identity.mat').write_text('1 0 0 0\n0 1 0 0\n0 0 1 0\n0 0 0 1\n')
        subprocess.run([*command, '-d', '3', '-rf', 'input.nii.gz',
                        '-rm', 'input.nii.gz', 'output.nii.gz', '-ri', 'NN',
                        '-r', 'identity.mat'], cwd=work, check=True)
        output = gzip.decompress((work / 'output.nii.gz').read_bytes())
        offset = int(struct.unpack_from('<f', output, 108)[0])
        actual = struct.unpack_from('<64f', output, offset)
        if actual != tuple(float(value) for value in range(64)):
            raise ValueError('Packaged Greedy failed the identity reslice fixture')
    return f'{version}\nPASS: gzipped NIfTI identity reslice, all 64 voxels match\n'


def package(target):
    expected_os, expected_arch = TARGETS[target]
    if (platform.system(), platform.machine()) != (expected_os, expected_arch):
        raise ValueError(f'{target} must be built and tested on {expected_os} {expected_arch}')
    subprocess.run([sys.executable, str(ROOT / 'scripts/greedy-third-party-notices.py'), '--check'], check=True)
    executable = 'greedy-rs.exe' if target == 'windows-x64' else 'greedy-rs'
    build_env = os.environ.copy()
    if target == 'windows-x64':
        build_env['RUSTFLAGS'] = f"{build_env.get('RUSTFLAGS', '')} -C target-feature=+crt-static"
    subprocess.run(['cargo', 'build', '--locked', '--release', '-p', 'greedy-rs'],
                   cwd=CRATE, env=build_env, check=True)
    dist = CRATE / 'dist'
    dist.mkdir(exist_ok=True)
    name = f'greedy-{VERSION}-{target}'
    with tempfile.TemporaryDirectory(prefix='greedy-package-') as directory:
        stage = Path(directory) / name
        stage.mkdir()
        shutil.copy2(CRATE / 'target/release' / executable, stage / executable)
        for filename in ('README.md', 'LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md'):
            shutil.copy2(CRATE / filename, stage / filename)
        if target == 'windows-x64':
            windows_signing.sign_tree(stage, (executable,))
            archive = dist / f'{name}.zip'
            with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as bundle:
                for item in stage.iterdir():
                    bundle.write(item, f'{name}/{item.name}')
        else:
            archive = dist / f'{name}.tar.gz'
            with tarfile.open(archive, 'w:gz') as bundle:
                bundle.add(stage, arcname=name)
        extracted = Path(directory) / 'extracted'
        if target == 'windows-x64':
            with zipfile.ZipFile(archive) as bundle:
                bundle.extractall(extracted)
        else:
            with tarfile.open(archive) as bundle:
                bundle.extractall(extracted, filter='data')
        if target == 'windows-x64':
            windows_signing.verify_tree(extracted / name, (executable,), native=True)
        report = verify(extracted / name / executable)
        native = ROOT / 'packages/greedy/native' / target
        native.mkdir(parents=True, exist_ok=True)
        shutil.copy2(extracted / name / executable, native / executable)
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    Path(f'{archive}.sha256').write_text(f'{digest}  {archive.name}\n', encoding='utf-8', newline='\n')
    # The Standalone catalog accepts a receipt only when it records the archive's digest and name.
    receipt = report.rstrip('\n') + f'\nsha256: {digest}  {archive.name}\n'
    Path(f'{archive}.validation.txt').write_text(receipt, encoding='utf-8', newline='\n')
    print(archive)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    build = commands.add_parser('package')
    build.add_argument('target', choices=TARGETS)
    check = commands.add_parser('verify')
    check.add_argument('executable')
    check.add_argument('--node-cli', action='store_true')
    args = parser.parse_args()
    if args.command == 'package':
        package(args.target)
    else:
        print(verify(args.executable, args.node_cli))
