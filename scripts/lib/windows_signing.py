"""Windows release signing policy shared by native and Node packagers.

Windows performs the trust check. Publication on another OS checks the exact
verified bytes and embedded PE certificates, not Windows certificate trust.
"""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import struct
import subprocess
import sys
import tempfile
import zipfile
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[2]
EVIDENCE = 'windows-signatures.json'
CONFIG = ('AZURE_CLIENT_ID', 'AZURE_TENANT_ID', 'AZURE_SUBSCRIPTION_ID',
          'AZURE_ARTIFACT_SIGNING_ENDPOINT', 'AZURE_ARTIFACT_SIGNING_ACCOUNT',
          'AZURE_ARTIFACT_SIGNING_PROFILE')


def enabled(environment=None):
    environment = os.environ if environment is None else environment
    value = environment.get('WINDOWS_SIGNING_ENABLED', '')
    if value not in ('', 'false', 'true'):
        raise ValueError('WINDOWS_SIGNING_ENABLED must be true, false or unset')
    if value == 'true':
        missing = [key for key in CONFIG if not environment.get(key, '').strip()]
        if missing:
            raise ValueError('Missing Windows signing configuration: ' + ', '.join(missing))
        if any('\n' in environment[key] or '\r' in environment[key] for key in CONFIG):
            raise ValueError('Windows signing configuration must contain single-line values')
        endpoint = urlsplit(environment['AZURE_ARTIFACT_SIGNING_ENDPOINT'])
        if endpoint.scheme != 'https' or not endpoint.hostname or not endpoint.hostname.endswith('.codesigning.azure.net') or endpoint.path != '/' or endpoint.query or endpoint.fragment or endpoint.username or endpoint.port:
            raise ValueError('Expected an HTTPS Azure Artifact Signing regional endpoint ending in /')
    return value == 'true'


def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def pe_signed(data):
    """Check the PE security directory carries a bounded WIN_CERTIFICATE."""
    try:
        if data[:2] != b'MZ':
            return False
        offset = struct.unpack_from('<I', data, 0x3c)[0]
        if data[offset:offset + 4] != b'PE\0\0':
            return False
        optional = offset + 24
        magic = struct.unpack_from('<H', data, optional)[0]
        directory = optional + {0x10b: 96, 0x20b: 112}[magic]
        address, size = struct.unpack_from('<II', data, directory + 4 * 8)
        if address % 8 or size < 8 or address + size > len(data):
            return False
        length, revision, kind = struct.unpack_from('<IHH', data, address)
        return 8 < length <= size and revision == 0x200 and kind == 2
    except (struct.error, KeyError):
        return False


def candidates(root):
    files = []
    for path in Path(root).rglob('*'):
        if path.is_symlink():
            raise ValueError(f'Symlinks are not supported in Windows signing payloads: {path}')
        if path.is_file() and path.suffix.lower() in ('.exe', '.dll', '.node'):
            with path.open('rb') as stream:
                if stream.read(2) == b'MZ':
                    files.append(path)
    return sorted(files)


def sign_tree(root, required=()):
    if not enabled():
        return
    if sys.platform != 'win32':
        raise RuntimeError('Windows signing requires a Windows runner')
    root = Path(root).resolve()
    files = candidates(root)
    for name in required:
        if (root / name).resolve() not in files:
            raise ValueError(f'Missing Windows executable: {name}')
    if not files:
        raise ValueError('No Windows executables to sign')
    evidence = root / EVIDENCE
    evidence.unlink(missing_ok=True)
    with tempfile.TemporaryDirectory(prefix='windows-signing-') as temporary:
        request = Path(temporary) / 'files.json'
        request.write_text(json.dumps([str(path) for path in files]), encoding='utf-8')
        subprocess.run(['pwsh', '-NoProfile', '-File', str(ROOT / 'scripts/windows-signing.ps1'),
                        '-FilesJson', str(request), '-Root', str(root), '-Evidence', str(evidence)], check=True)
    verify_tree(root, required)


def verify_tree(root, required=(), native=False):
    if not enabled():
        return
    root = Path(root).resolve()
    files = candidates(root)
    record = json.loads((root / EVIDENCE).read_text(encoding='utf-8-sig'))
    expected = {path.relative_to(root).as_posix() for path in files}
    if record.get('schema') != 1 or set(record.get('files', {})) != expected or not expected:
        raise ValueError('Windows signature evidence does not cover the payload')
    if not set(required).issubset(expected):
        raise ValueError('Windows signature evidence is missing required executables')
    for name, proof in record['files'].items():
        path = PurePosixPath(name)
        if path.is_absolute() or '..' in path.parts:
            raise ValueError('Unsafe signing evidence path')
        file = root / name
        if proof.get('sha256') != digest(file) or proof.get('verified') != 'signtool /pa /all /tw' or not proof.get('timestamp'):
            raise ValueError(f'Windows signature verification evidence is invalid: {name}')
        if not pe_signed(file.read_bytes()):
            raise ValueError(f'Windows executable has no embedded signature: {name}')
    if native:
        if sys.platform != 'win32':
            raise RuntimeError('Native signature verification requires Windows')
        with tempfile.TemporaryDirectory(prefix='windows-verify-') as temporary:
            request = Path(temporary) / 'files.json'
            request.write_text(json.dumps([str(path) for path in files]), encoding='utf-8')
            subprocess.run(['pwsh', '-NoProfile', '-File', str(ROOT / 'scripts/windows-signing.ps1'),
                            '-FilesJson', str(request), '-Root', str(root), '-VerifyOnly'], check=True)


def verify_zip(archive, required=()):
    if not enabled():
        return
    with tempfile.TemporaryDirectory(prefix='windows-archive-') as temporary:
        root = Path(temporary)
        with zipfile.ZipFile(archive) as bundle:
            for member in bundle.infolist():
                path = PurePosixPath(member.filename.replace('\\', '/'))
                if path.is_absolute() or '..' in path.parts or member.filename.startswith('\\'):
                    raise ValueError('Unsafe Windows archive path')
                if path.name != EVIDENCE and path.suffix.lower() not in ('.exe', '.dll', '.node'):
                    continue
                destination = root.joinpath(*path.parts)
                if member.is_dir():
                    destination.mkdir(parents=True, exist_ok=True)
                else:
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    destination.write_bytes(bundle.read(member))
        evidence = list(root.rglob(EVIDENCE))
        if len(evidence) != 1:
            raise ValueError('Expected one Windows signature evidence record')
        payload = evidence[0].parent
        if any(not path.is_relative_to(payload) for path in candidates(root)):
            raise ValueError('Windows archive contains executables outside the verified payload')
        verify_tree(payload, required, native=sys.platform == 'win32')


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('command', choices=('sign', 'verify', 'check-config'))
    parser.add_argument('path', nargs='?')
    parser.add_argument('--required', action='append', default=[])
    args = parser.parse_args()
    if args.command == 'check-config':
        enabled()
    elif args.command == 'sign':
        sign_tree(args.path, args.required)
    else:
        verify_zip(args.path, args.required)
