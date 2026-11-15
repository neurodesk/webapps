"""Reject incomplete censuses before reporting agreement statistics."""
import json
import copy
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock

import numpy as np

from polyshape_hole_census import family, VARIANTS


class HoleCensusTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.case = {'id': 'example'}
        self.write('points', [[0, 0], [1, 0], [0, 1], [2, 0], [3, 0], [2, 1]])
        self.write('counts', [[3], [3]])
        self.write('defaultHoles', [[0], [1]])
        self.write('defaultHolesCounts', [[1], [1]])

    def write(self, name, values):
        array = np.asarray(values, dtype='<f8')
        filename = name + '.f64'
        array.T.tofile(self.root / filename)
        self.case[name] = {
            'file': filename, 'shape': list(array.shape),
            'class': 'double', 'imaginary': '',
        }
        (self.root / 'geometry.json').write_text(json.dumps({'cases': [self.case]}))

    def oracle(self, count):
        results = [
            {'variants': {v: {'holes': i % 2} for v in VARIANTS}}
            for i in range(count)
        ]
        return Mock(evaluate=Mock(return_value=results))

    def test_complete_census_counts_every_polygon(self):
        result = family(self.root, 'example', self.oracle(2))
        self.assertEqual(result['polygons'], 2)
        self.assertEqual(result['matlabWithHoles'], 1)
        for variant in VARIANTS:
            self.assertEqual(result[f'{variant}:equal'], 2)

    def test_missing_annotation_fails_before_oracle(self):
        self.write('defaultHoles', [[0]])
        self.write('defaultHolesCounts', [[1]])
        oracle = self.oracle(2)
        with self.assertRaisesRegex(ValueError, 'expected 2 hole annotations, got 1'):
            family(self.root, 'example', oracle)
        oracle.evaluate.assert_not_called()

    def test_incomplete_or_extra_oracle_results_fail(self):
        for count in (0, 1, 3):
            with self.subTest(count=count):
                with self.assertRaisesRegex(ValueError, 'expected 2 oracle results'):
                    family(self.root, 'example', self.oracle(count))

    def test_malformed_descriptors_fail(self):
        changes = [
            ('points', 'shape', [3, 4]),
            ('counts', 'shape', [1, 2]),
            ('defaultHoles', 'shape', [1, 2]),
            ('defaultHolesCounts', 'shape', [2.0, 1]),
            ('points', 'class', 'single'),
            ('defaultHoles', 'imaginary', 'imag.f64'),
        ]
        for field, key, value in changes:
            with self.subTest(field=field, key=key):
                case = copy.deepcopy(self.case)
                case[field][key] = value
                (self.root / 'geometry.json').write_text(json.dumps({'cases': [case]}))
                with self.assertRaises(ValueError):
                    family(self.root, 'example', self.oracle(2))

    def test_nonbinary_hole_flags_fail(self):
        for value in (-1, 0.5, 2, float('nan'), float('inf')):
            with self.subTest(value=value):
                self.write('defaultHoles', [[0], [value]])
                with self.assertRaises(ValueError):
                    family(self.root, 'example', self.oracle(2))

    def test_trailing_byte_fails(self):
        with (self.root / 'points.f64').open('ab') as destination:
            destination.write(b'\x00')
        with self.assertRaisesRegex(ValueError, 'byte count'):
            family(self.root, 'example', self.oracle(2))


if __name__ == '__main__':
    unittest.main()
