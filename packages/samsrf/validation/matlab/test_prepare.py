import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock

import build_container
import prepare


def git(directory, *args):
    return subprocess.run(['git', '-C', str(directory), *args], check=True,
                          capture_output=True, text=True).stdout.strip()


class RepairSets(unittest.TestCase):
    """The CLI set adds the HRF column repair; the source set stays three repairs."""

    def checkout(self):
        root = Path(tempfile.mkdtemp(dir=os.environ.get('TMPDIR')))
        source = root / 'samsrf'
        source.mkdir()
        git(source, 'init', '-q')
        for name, before, _ in prepare.repairs(cli=True):
            path = source / name
            path.parent.mkdir(parents=True, exist_ok=True)
            text = path.read_text() if path.exists() else '% fixture\n'
            path.write_text(text + before + '\n')
        git(source, 'add', '.')
        git(source, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'fixture')
        return root, source, {**prepare.SOURCE, 'commit': git(source, 'rev-parse', 'HEAD')}

    def test_cli_repair_keeps_the_doublegamma_column_and_records_hashes(self):
        root, source, pinned = self.checkout()
        with mock.patch.object(prepare, 'SOURCE', pinned):
            prepare.prepare(source, root / 'out', cli=True)
        record = json.loads((root / 'out' / 'source.json').read_text())
        self.assertEqual(record['repairSet'], 'samsrfanalysis-cli')
        paths = [item['path'] for item in record['files']]
        self.assertEqual(paths.count('Fitting/samsrf_fit_prf.m'), 1)
        self.assertEqual(paths.count('Fitting/samsrf_revcor_prf.m'), 1)
        for name in ['Fitting/samsrf_fit_prf.m', 'Fitting/samsrf_revcor_prf.m']:
            text = (source / name).read_text()
            self.assertIn('samsrf_doublegamma(Model.TR, [fP(1:2) 1 1 fP(3) 0 32]) * fP(4);', text)
            self.assertNotIn("32])'", text)
        self.assertTrue(all(item['originalSha256'] != item['patchedSha256'] for item in record['files']))

    def test_source_reference_keeps_its_three_repairs(self):
        root, source, pinned = self.checkout()
        with mock.patch.object(prepare, 'SOURCE', pinned):
            prepare.prepare(source, root / 'out')
        record = json.loads((root / 'out' / 'source.json').read_text())
        self.assertNotIn('repairSet', record)
        self.assertEqual(len(record['files']), 3)
        self.assertIn("32])' * fP(4);", (source / 'Fitting/samsrf_fit_prf.m').read_text())

    def test_the_build_requires_the_cli_set(self):
        for cli in [False, True]:
            with self.subTest(cli=cli):
                root, source, pinned = self.checkout()
                with mock.patch.object(prepare, 'SOURCE', pinned), \
                        mock.patch.object(build_container, 'SOURCE', pinned):
                    prepare.prepare(source, root / 'out', cli=cli)
                    with self.assertRaisesRegex(ValueError, 'SPM' if cli else 'prepare.py --cli'):
                        build_container.verify_source(source, source)


if __name__ == '__main__':
    unittest.main()
