import json
import os
from pathlib import Path
import tempfile
import unittest

from capture_environment import capture, CONTROLS


class CaptureEnvironment(unittest.TestCase):
    def test_only_numerical_requests_are_retained(self):
        with tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR')) as output:
            capture(output, {**CONTROLS, 'UNRELATED_SECRET': 'do not record'})
            self.assertEqual(json.loads((Path(output) / 'environment-request.json').read_text()), CONTROLS)

    def test_missing_or_changed_requests_fail_without_a_receipt(self):
        with tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR')) as output:
            for key in CONTROLS:
                for value in ['', 'unexpected']:
                    with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                        capture(output, {**CONTROLS, key: value})
            self.assertFalse((Path(output) / 'environment-request.json').exists())

    def test_a_probe_branch_must_be_the_one_requested(self):
        with tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR')) as output:
            with self.assertRaises(ValueError):
                capture(output, CONTROLS, 'AUTO')
            capture(output, {**CONTROLS, 'MKL_CBWR': 'AUTO'}, 'AUTO')
            self.assertEqual(json.loads((Path(output) / 'environment-request.json').read_text())['MKL_CBWR'], 'AUTO')

    def test_existing_receipt_cannot_be_relabelled(self):
        with tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR')) as output:
            capture(output, CONTROLS)
            with self.assertRaises(FileExistsError):
                capture(output, CONTROLS)


if __name__ == '__main__':
    unittest.main()
