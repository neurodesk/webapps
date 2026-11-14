import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('qr_lane_models', Path(__file__).with_name('qr-lane-models.py'))
qr_lane_models = importlib.util.module_from_spec(spec)
spec.loader.exec_module(qr_lane_models)

# LCA subtree sizes of MKL's AMD `sgemv` probe at length 10 (record_qr_kernels.m,
# qr-kernels-reference.json, ubuntu-22.04-1): row i lists pairs (i, j > i).
AMD_SGEMV_10 = [
    [2, 9, 5, 9, 3, 9, 5, 9, 10],
    [9, 5, 9, 3, 9, 5, 9, 10],
    [9, 4, 9, 2, 9, 4, 10],
    [9, 5, 9, 2, 9, 10],
    [9, 4, 9, 2, 10],
    [9, 5, 9, 10],
    [9, 4, 10],
    [9, 10],
    [10],
]


class LaneModels(unittest.TestCase):
    def test_the_amd_sgemv_model_gives_the_recorded_tree(self):
        sizes = qr_lane_models.lca_sizes(10, 'seed', 8, (4, 2, 1), 'seq')
        for i, row in enumerate(AMD_SGEMV_10):
            for offset, expected in enumerate(row):
                self.assertEqual(sizes[(i, i + 1 + offset)], expected, (i, i + 1 + offset))

    def test_other_models_give_other_trees(self):
        recorded = {(i, i + 1 + offset): size for i, row in enumerate(AMD_SGEMV_10) for offset, size in enumerate(row)}
        for model in [('seed', 8, (2, 4, 1), 'seq'), ('vector', 8, (4, 2, 1), 'seq'), ('seed', 8, (4, 2, 1), 'mod')]:
            self.assertNotEqual(qr_lane_models.lca_sizes(10, *model), recorded, model)

    def test_power_of_two_tails_fill_from_lane_zero(self):
        # Intel's dgemv at length 7: 4 + 2 + 1 elements, each chunk from lane 0.
        sizes = qr_lane_models.lca_sizes(7, 'vector', 16, (8, 4, 1, 2), 'pow2')
        self.assertEqual(sizes[(0, 4)], 2)
        self.assertEqual(sizes[(1, 5)], 2)
        self.assertEqual(sizes[(0, 6)], 3)
        self.assertEqual(sizes[(2, 3)], 2)
        self.assertEqual(sizes[(0, 2)], 7)

    def test_every_candidate_is_a_full_binary_tree(self):
        for model in list(qr_lane_models.candidates(8))[:200]:
            sizes = qr_lane_models.lca_sizes(9, *model)
            self.assertEqual(len(sizes), 36, model)
            self.assertTrue(all(2 <= size <= 9 for size in sizes.values()), model)


if __name__ == '__main__':
    unittest.main()
