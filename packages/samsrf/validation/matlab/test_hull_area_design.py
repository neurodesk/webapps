import collections
import json
from pathlib import Path
import unittest
import struct
import tempfile

import hull_area_design as design
import hull_area_report as report

HERE = Path(__file__).resolve().parent
# hull-area-predictions.md, frozen before the first recording.
FROZEN = '14ec8549270429828f78c0c47276000d6b13237772553814d5bfdc481c06f567'
# Its addendum's fresh held-out set, frozen before dispatch 2.
FROZEN_FRESH = '3a0966d7a1c9df424a2d16db9b0f6f77252d7e9fa514aa760f0542bb6a81c9d4'


class Predictions(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.inputs = json.loads((HERE / 'hull-area-inputs.json').read_text())

    def test_the_committed_inputs_give_the_frozen_predictions(self):
        self.assertEqual(design.digest(design.predictions(self.inputs)), FROZEN)
        fresh = json.loads((HERE / 'hull-area-inputs-2.json').read_text())
        self.assertEqual(design.digest(design.predictions(fresh)), FROZEN_FRESH)

    def test_the_fresh_set_is_held_out_only_and_new(self):
        fresh = json.loads((HERE / 'hull-area-inputs-2.json').read_text())
        self.assertEqual(collections.Counter((s['family'], s['role']) for s in fresh['sets']),
                         {('blob', 'fresh'): 40, ('blob-reversed', 'fresh'): 20, ('small', 'fresh'): 20})
        self.assertEqual(collections.Counter(g['role'] for g in fresh['linspace']), {'fresh': 44})
        identities = {s['identity'] for s in self.inputs['sets']} | {g['identity'] for g in self.inputs['linspace']}
        fresh_identities = [s['identity'] for s in fresh['sets']] + [g['identity'] for g in fresh['linspace']]
        self.assertEqual(len(fresh_identities), len(set(fresh_identities)))
        self.assertFalse(identities & set(fresh_identities))

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
    def test_dispatch_one_requires_its_own_complete_inventory_explicitly(self):
        inputs = json.loads((HERE / 'hull-area-inputs.json').read_text())
        cases = [{'kind': 'hull-area', 'id': 'area_' + entry['identity']}
                 for entry in inputs['sets']]
        cases += [{'kind': 'linspace', 'id': 'linspace_' + entry['identity']}
                  for entry in inputs['linspace']]
        with tempfile.TemporaryDirectory() as temporary:
            recording = Path(temporary)
            host = recording / 'host'
            host.mkdir()
            (host / 'environment.json').write_text(json.dumps({
                'mode': 'hull-area', 'cpu': 'Model name: Intel Xeon\n'}))
            listing = host / 'geometry.json'
            listing.write_text(json.dumps({'cases': cases}))
            # Inventory validation is independent of which numerical roles are selected.
            result = report.judge(recording, set(), [], dispatch=1)
            self.assertFalse(result['decides'])
            with self.assertRaisesRegex(AssertionError, 'inventory'):
                report.judge(recording, set(), [])
            listing.write_text(json.dumps({'cases': cases[1:]}))
            with self.assertRaisesRegex(AssertionError, 'inventory'):
                report.judge(recording, set(), [], dispatch=1)

    def test_recorded_indices_are_integers_in_range(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            descriptor = {'class': 'double', 'imaginary': '', 'shape': [1, 1], 'file': 'k.f64'}
            for value in [1.5, 0.0, 4.0, float('nan'), float('inf')]:
                with self.subTest(value=value):
                    (root / 'k.f64').write_bytes(struct.pack('<d', value))
                    with self.assertRaises(AssertionError):
                        report.indices(root, descriptor, 1, 3)
            (root / 'k.f64').write_bytes(struct.pack('<d', 2.0))
            self.assertEqual(report.indices(root, descriptor, 1, 3), [(2,)])

    def test_all_recorded_identities_are_required_once(self):
        spec = {'discovery': None, 'heldout': None, 'fresh': None}
        grids = {'grid': None}
        cases = [{'kind': 'hull-area', 'id': 'area_' + name} for name in spec]
        cases.append({'kind': 'linspace', 'id': 'linspace_grid'})
        report.inventory(cases, spec, grids)
        for bad in [cases[1:], cases + cases[:1], cases[1:] + cases[1:2],
                    cases + [{'kind': 'hull-area', 'id': 'area_extra'}]]:
            with self.subTest(cases=bad), self.assertRaises(AssertionError):
                report.inventory(bad, spec, grids)

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
