import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import nibabel as nib
import numpy as np


COMPARATOR = Path(__file__).parents[1] / "scripts" / "compare_upstream_output.py"


class UpstreamComparisonTests(unittest.TestCase):
    def compare(self, reference, candidate):
        with tempfile.TemporaryDirectory(prefix="musclemap-comparison-") as directory:
            paths = [Path(directory) / name for name in ("reference.nii", "candidate.nii")]
            for path, labels in zip(paths, (reference, candidate)):
                nib.save(nib.Nifti1Image(labels, np.eye(4)), path)
            result = subprocess.run(
                [sys.executable, str(COMPARATOR), "--reference", str(paths[0]),
                 "--candidate", str(paths[1])],
                capture_output=True,
                text=True,
                check=False,
            )
        return result.returncode, json.loads(result.stdout)

    def test_small_label_failure_is_not_hidden_by_aggregate_agreement(self):
        reference = np.zeros((100, 100, 1), dtype=np.uint8)
        reference[:10, :, :] = 1
        reference[20, :10, :] = 2
        candidate = reference.copy()
        candidate[20, :5, :] = 0

        code, report = self.compare(reference, candidate)

        self.assertGreater(report["overallAgreement"], 0.99)
        self.assertGreater(report["foregroundDice"], 0.95)
        self.assertAlmostEqual(report["perLabel"]["2"]["dice"], 2 / 3)
        self.assertEqual(report["thresholds"]["presentLabelDice"], 0.95)
        self.assertEqual(report["status"], "failed")
        self.assertEqual(code, 1)

    def test_matching_labels_pass_the_same_gate(self):
        reference = np.array([[[0], [1]], [[2], [2]]], dtype=np.uint8)

        code, report = self.compare(reference, reference)

        self.assertEqual(code, 0)
        self.assertEqual(report["status"], "passed")
        self.assertTrue(all(label["dice"] == 1 for label in report["perLabel"].values()))


if __name__ == "__main__":
    unittest.main()
