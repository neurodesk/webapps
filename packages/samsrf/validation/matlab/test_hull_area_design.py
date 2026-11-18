import collections
import json
from pathlib import Path
import unittest

import hull_area_design as design

HERE = Path(__file__).resolve().parent
# hull-area-predictions.md, frozen before the first recording.
FROZEN = '14ec8549270429828f78c0c47276000d6b13237772553814d5bfdc481c06f567'


class Predictions(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.inputs = json.loads((HERE / 'hull-area-inputs.json').read_text())

    def test_the_committed_inputs_give_the_frozen_predictions(self):
        self.assertEqual(design.digest(design.predictions(self.inputs)), FROZEN)

    def test_the_inventory_is_the_preregistered_one(self):
        sets = collections.Counter((s['family'], s['role']) for s in self.inputs['sets'])
        self.assertEqual(sets, {('cli', 'discovery'): 42, ('cli-reversed', 'discovery'): 42, ('blob', 'discovery'): 20, ('small', 'discovery'): 20,
                                ('blob', 'heldout'): 120, ('blob-reversed', 'heldout'): 60, ('small', 'heldout'): 40})
        grids = collections.Counter(g['role'] for g in self.inputs['linspace'])
        self.assertEqual(grids, {'discovery': 76, 'heldout': 88})
        identities = [s['identity'] for s in self.inputs['sets']] + [g['identity'] for g in self.inputs['linspace']]
        self.assertEqual(len(identities), len(set(identities)))
        self.assertTrue(all(identity.replace('_', '').isalnum() for identity in identities))

    def test_runs_are_ascending_pixels_of_their_grid(self):
        sizes = {g['identity']: g['columns'] * g['rows'] for g in self.inputs['grids']}
        for g in self.inputs['grids']:
            self.assertEqual((len(g['xs']), len(g['ys'])), (g['columns'], g['rows']))
        for s in self.inputs['sets']:
            last = -1
            for start, length in s['runs']:
                self.assertTrue(start > last and length >= 1 and start + length <= sizes[s['grid']], s['identity'])
                last = start + length - 1
            self.assertGreaterEqual(sum(length for _, length in s['runs']), 3)

    def test_reversed_sets_are_their_originals_backwards(self):
        by = {s['identity']: s for s in self.inputs['sets']}
        for s in self.inputs['sets']:
            if s['reverse']:
                original = by[s['identity'].replace('cli_reversed_', 'cli_').replace('_reversed', '')]
                self.assertEqual(design.decoded_points(self.inputs, s), design.decoded_points(self.inputs, original)[::-1])


class Models(unittest.TestCase):
    def test_grids(self):
        self.assertEqual(design.grid('L0', 2.0, 5), [-2.0, -1.0, 0.0, 1.0, 2.0])
        self.assertEqual(design.grid('L1', 0.1, 20)[-1], 0.09999999999999999)
        self.assertEqual(design.grid('L0', 0.1, 20)[-1], 0.1)
        self.assertEqual([design.grid(m, 3.0, 1) for m in design.GRID_MODELS], [[3.0]] * 4)

    def test_boundary_keeps_collinear_points_from_the_first_input_point(self):
        # geometry.rs: delaunay_boundary_keeps_collinear_points_from_the_first_input_point.
        points = [(float(x), float(y)) for x in range(3) for y in (2, 1, 0)]
        ring = design.boundary(points)
        self.assertEqual(ring, [(0.0, 2.0), (0.0, 1.0), (0.0, 0.0), (1.0, 0.0), (2.0, 0.0), (2.0, 1.0), (2.0, 2.0), (1.0, 2.0)])
        self.assertEqual(design.indices(points, ring), [1, 2, 3, 6, 9, 8, 7, 4, 1])
        self.assertIsNone(design.boundary([(0.0, 0.0), (1.0, 1.0), (2.0, 2.0)]))

    def test_every_area_model_is_exact_on_a_square(self):
        points = [(float(x), float(y)) for x in range(3) for y in (2, 1, 0)]
        k = design.indices(points, design.boundary(points))
        self.assertEqual(design.areas(points, k), dict.fromkeys(design.AREA_MODELS, 4.0))
        triangles = [(1, 4, 2), (2, 4, 5), (2, 5, 3), (3, 5, 6), (4, 7, 5), (5, 7, 8), (5, 8, 6), (6, 8, 9)]
        for model in ('T1', 'T2', 'T3', 'T4', 'T5'):
            self.assertEqual(design.triangle_areas(points, triangles, model), 4.0, model)


if __name__ == '__main__':
    unittest.main()
