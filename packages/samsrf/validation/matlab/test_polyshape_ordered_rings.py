"""Unit tests of polyshape_ordered_rings.py (no recording needed)."""
import json
import os
from pathlib import Path
import struct
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import polyshape_ordered_rings as rings  # noqa: E402


def bits(points):
    return [(rings.to_bits(x), rings.to_bits(y)) for x, y in points]


SQUARE = bits([(0.0, 0.0), (2.0, 0.0), (2.0, 1.0), (1.0, 2.0), (0.0, 1.0)])
TRIANGLE = bits([(5.0, 5.0), (6.0, 5.0), (5.0, 6.0)])


class CanonicalCycle(unittest.TestCase):
    def test_start_and_direction_are_normalised(self):
        base = rings.canonical_cycle(SQUARE)
        self.assertEqual(rings.canonical_cycle(SQUARE[2:] + SQUARE[:2]), base)
        self.assertEqual(rings.canonical_cycle(list(reversed(SQUARE))), base)

    def test_swapped_vertices_are_another_cycle(self):
        swapped = list(SQUARE)
        swapped[1], swapped[3] = swapped[3], swapped[1]
        self.assertEqual(sorted(swapped), sorted(SQUARE))
        self.assertNotEqual(rings.canonical_cycle(swapped), rings.canonical_cycle(SQUARE))


class Classify(unittest.TestCase):
    def test_first_difference(self):
        hull = SQUARE
        same = [(0, SQUARE), (0, TRIANGLE)]
        self.assertEqual(rings.classify(hull, same, hull, list(reversed(same)))[0], 'equal')
        swapped = list(SQUARE)
        swapped[1], swapped[3] = swapped[3], swapped[1]
        self.assertEqual(rings.classify(hull, same, hull, [(0, swapped), (0, TRIANGLE)])[0], 'connectivity')
        self.assertEqual(rings.classify(hull, same, hull, [(0, SQUARE)])[0], 'survival')
        self.assertEqual(rings.classify(hull, same, hull, [(0, SQUARE), (1, TRIANGLE)])[0], 'holes')
        joined = [(0, SQUARE + TRIANGLE)]
        self.assertEqual(rings.classify(hull, same, hull, joined)[0], 'connectivity')

    def test_cycles_differ_with_equal_edges(self):
        # Two triangles sharing a vertex as two rings, or as one ring through it twice.
        a, b, c, d, e = bits([(0.0, 0.0), (1.0, 0.0), (0.0, 1.0), (-1.0, 0.0), (0.0, -1.0)])
        two = [(0, [a, b, c]), (0, [a, d, e])]
        one = [(0, [a, b, c, a, d, e])]
        self.assertEqual(rings.classify([], two, [], one)[0], 'cycles')

    def test_orientation_is_exact(self):
        # A one-ULP-high triangle far from the origin: its double shoelace cancels.
        x = 1e5
        thin = bits([(x, 0.0), (x + 1.0, 0.0), (x + 0.5, 2.0 ** -40)])
        self.assertGreater(rings.signed_area(thin), 0)
        self.assertLess(rings.signed_area(list(reversed(thin))), 0)


class SplitRings(unittest.TestCase):
    def test_nan_rows_separate_nonempty_boundaries(self):
        nan = float('nan')
        rows = [(0.0, 0.0), (1.0, 0.0), (0.0, 1.0), (nan, nan), (5.0, 5.0), (6.0, 5.0), (5.0, 6.0)]
        self.assertEqual(len(rings.split_rings(rows)), 2)
        for bad in ([(0.0, 0.0), (nan, nan), (nan, nan), (1.0, 1.0)], [(0.0, 0.0), (nan, nan)]):
            with self.assertRaises(ValueError):
                rings.split_rings(bad)


class RecordedFlags(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        case = {'id': 'triangle', 'kind': 'polygon-batch', 'cases': 1}
        arrays = {
            'points': ([0, 1, 0, 0, 0, 1], [3, 2]),
            'counts': ([3], [1, 1]),
            'hull': ([0, 1, 0, 0, 0, 1], [3, 2]),
            'hullCounts': ([3], [1, 1]),
            'simplified': ([0, 1, 0, 0, 0, 1], [3, 2]),
            'simplifiedCounts': ([3], [1, 1]),
            'defaultHoles': ([0], [1, 1]),
            'defaultHolesCounts': ([1], [1, 1]),
            'error': ([0], [1, 1]),
        }
        for name, (values, shape) in arrays.items():
            filename = f'{name}.f64'
            (self.root / filename).write_bytes(struct.pack(f'<{len(values)}d', *values))
            case[name] = {'class': 'double', 'imaginary': '', 'shape': shape, 'file': filename}
        (self.root / 'geometry.json').write_text(json.dumps({'cases': [case]}))

    def test_nonbinary_recorded_flags_are_rejected_before_conversion(self):
        baseline = rings.digest(self.root, 'triangle')
        for field in ('defaultHoles', 'error'):
            for value in (0.5, -0.5, 1.5, 2, float('nan'), float('inf'), -float('inf')):
                with self.subTest(field=field, value=value):
                    path = self.root / f'{field}.f64'
                    path.write_bytes(struct.pack('<d', value))
                    try:
                        with self.assertRaises(ValueError):
                            rings.digest(self.root, 'triangle')
                    finally:
                        path.write_bytes(struct.pack('<d', 0))
        self.assertEqual(rings.digest(self.root, 'triangle'), baseline)

    def test_binary_flags_keep_their_values(self):
        for value in (0, 1):
            for field in ('defaultHoles', 'error'):
                (self.root / f'{field}.f64').write_bytes(struct.pack('<d', value))
            batch = rings.Batch(self.root, 'triangle')
            self.assertEqual(batch.failed, [bool(value)])
            self.assertEqual(batch.rings[0][0][0], value)


if __name__ == '__main__':
    unittest.main()
