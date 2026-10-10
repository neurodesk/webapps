"""Offline policy tests. Synthetic PE certificates are fixtures, not signatures."""
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

import windows_signing as signing

CONFIGURED = dict.fromkeys(signing.CONFIG, 'configured') | {
    'WINDOWS_SIGNING_ENABLED': 'true',
    'AZURE_ARTIFACT_SIGNING_ENDPOINT': 'https://eus.codesigning.azure.net/',
}


def pe(signed=True):
    data = bytearray(512)
    data[:2] = b'MZ'
    struct.pack_into('<I', data, 0x3c, 128)
    data[128:132] = b'PE\0\0'
    struct.pack_into('<H', data, 152, 0x20b)
    if signed:
        struct.pack_into('<II', data, 152 + 112 + 32, 480, 32)
        struct.pack_into('<IHH', data, 480, 32, 0x200, 2)
    return bytes(data)


def mock_sign(root):
    root = Path(root)
    files = {}
    for path in signing.candidates(root):
        path.write_bytes(pe())
        files[path.relative_to(root).as_posix()] = {
            'sha256': signing.digest(path), 'verified': 'signtool /pa /all /tw',
            'timestamp': 'mock fixture timestamp',
        }
    (root / signing.EVIDENCE).write_text(json.dumps({'schema': 1, 'files': files}))


class WindowsSigningTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        (self.root / 'runtime').mkdir()
        (self.root / 'tool.exe').write_bytes(pe(False))
        (self.root / 'runtime/node.exe').write_bytes(pe(False))
        self.required = ('tool.exe', 'runtime/node.exe')

    def test_disabled_does_not_call_signer_or_require_configuration(self):
        with patch.dict(os.environ, {'WINDOWS_SIGNING_ENABLED': 'false'}), patch.object(signing.subprocess, 'run') as run:
            signing.sign_tree(self.root, self.required)
            signing.verify_zip(self.root / 'absent.zip')
            run.assert_not_called()

    def test_enabled_configuration_fails_closed(self):
        for flag in ('TRUE', '1', 'yes'):
            with self.assertRaises(ValueError):
                signing.enabled({'WINDOWS_SIGNING_ENABLED': flag})
        for key in signing.CONFIG:
            config = CONFIGURED.copy()
            config.pop(key)
            with self.subTest(key=key), self.assertRaises(ValueError):
                signing.enabled(config)
        for url in ('http://eus.codesigning.azure.net/', 'https://evil.test/', 'https://eus.codesigning.azure.net/?x=1'):
            with self.assertRaises(ValueError):
                signing.enabled(CONFIGURED | {'AZURE_ARTIFACT_SIGNING_ENDPOINT': url})
        with self.assertRaises(ValueError):
            signing.enabled(CONFIGURED | {'AZURE_CLIENT_ID': 'a\nWINDOWS_SIGNING_ENABLED=false'})

    def test_mock_signer_changes_launcher_and_node_before_verification(self):
        def run(command, **kwargs):
            request = Path(command[command.index('-FilesJson') + 1])
            self.assertEqual(set(json.loads(request.read_text())), {str((self.root / name).resolve()) for name in self.required})
            mock_sign(self.root)
        with patch.dict(os.environ, CONFIGURED), patch.object(signing.sys, 'platform', 'win32'), patch.object(signing.subprocess, 'run', side_effect=run):
            signing.sign_tree(self.root, self.required)
            signing.verify_tree(self.root, self.required)
        self.assertTrue(signing.pe_signed((self.root / 'runtime/node.exe').read_bytes()))

    def test_signer_failure_propagates_and_does_not_accept_stale_proof(self):
        mock_sign(self.root)
        with patch.dict(os.environ, CONFIGURED), patch.object(signing.sys, 'platform', 'win32'), patch.object(signing.subprocess, 'run', side_effect=subprocess.CalledProcessError(1, 'mock')):
            with self.assertRaises(subprocess.CalledProcessError):
                signing.sign_tree(self.root, self.required)
        self.assertFalse((self.root / signing.EVIDENCE).exists())

    def test_coverage_unsigned_bytes_missing_timestamp_and_tampering_fail(self):
        mutations = ('unsigned', 'timestamp', 'tamper', 'coverage', 'required')
        for mutation in mutations:
            mock_sign(self.root)
            proof = self.root / signing.EVIDENCE
            record = json.loads(proof.read_text())
            if mutation == 'unsigned':
                (self.root / 'tool.exe').write_bytes(pe(False))
                record['files']['tool.exe']['sha256'] = signing.digest(self.root / 'tool.exe')
            elif mutation == 'timestamp':
                record['files']['tool.exe']['timestamp'] = ''
            elif mutation == 'tamper':
                (self.root / 'tool.exe').write_bytes(pe() + b'changed')
            elif mutation == 'coverage':
                del record['files']['runtime/node.exe']
            else:
                (self.root / 'runtime/node.exe').unlink()
                del record['files']['runtime/node.exe']
            proof.write_text(json.dumps(record))
            with patch.dict(os.environ, CONFIGURED), self.subTest(mutation=mutation), self.assertRaises(ValueError):
                signing.verify_tree(self.root, self.required)
            (self.root / 'runtime/node.exe').write_bytes(pe())

    def test_zip_publication_checks_signed_payload_and_rejects_traversal(self):
        mock_sign(self.root)
        archive = self.root / 'release.zip'
        with zipfile.ZipFile(archive, 'w') as bundle:
            for path in [self.root / name for name in (*self.required, signing.EVIDENCE)]:
                bundle.write(path, f'tool-release/{path.relative_to(self.root).as_posix()}')
        with patch.dict(os.environ, CONFIGURED), patch.object(signing.sys, 'platform', 'linux'):
            signing.verify_zip(archive, self.required)
            with zipfile.ZipFile(archive, 'a') as bundle:
                bundle.writestr('../escape.exe', pe())
            with self.assertRaises(ValueError):
                signing.verify_zip(archive, self.required)

    def test_windows_drive_paths_are_rejected_on_every_host(self):
        for name in ('C:/escape.exe', 'C:escape.exe', '//host/share/escape.exe'):
            archive = self.root / 'unsafe.zip'
            with zipfile.ZipFile(archive, 'w') as bundle:
                bundle.writestr(name, pe())
            with patch.dict(os.environ, CONFIGURED), self.subTest(name=name), self.assertRaises(ValueError):
                signing.verify_zip(archive)

    def test_pe_bounds_are_checked(self):
        self.assertTrue(signing.pe_signed(pe()))
        self.assertFalse(signing.pe_signed(pe(False)))
        self.assertFalse(signing.pe_signed(pe()[:500]))
        self.assertFalse(signing.pe_signed(b'MZ'))


if __name__ == '__main__':
    unittest.main()
