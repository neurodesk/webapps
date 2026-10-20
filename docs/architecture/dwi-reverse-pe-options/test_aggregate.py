"""Exercise the issue #471 gate through the aggregation command."""

import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("aggregate.py")


class AcceptanceGateTests(unittest.TestCase):
    def aggregate(self, subjects, explicit=True):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name, rows in subjects.items():
                path = root / name
                path.mkdir()
                (path / "summary.json").write_text(json.dumps(rows))
            command = [sys.executable, str(SCRIPT), str(root)]
            if explicit:
                command.extend(subjects)
            return subprocess.check_output(command, text=True, stderr=subprocess.STDOUT)

    def rows(self, appa=0.8, bbr=0.99, single_appa=1.0, include_candidate=True):
        def row(method, appa, bbr):
            return {
                "method": method,
                "appa_mad": appa,
                "bbr_cost": bbr,
                "field_vs_topup_mad_demeaned_hz": 1.0,
                "field_vs_topup_mad_hz": 1.0,
                "field_vs_topup_r": 0.9,
            }

        rows = [row("topup", 1.0, 1.0), row("topup-single", single_appa, 1.0)]
        if include_candidate:
            rows.append(row("drbuddi", appa, bbr))
        return rows

    def test_better_image_metrics_pass_on_every_subject(self):
        output = self.aggregate({"one": self.rows(), "two": self.rows()})
        self.assertIn("Passing every subject: drbuddi.", output)

    def test_worse_t1w_alignment_fails_even_within_two_percent(self):
        output = self.aggregate({"one": self.rows(bbr=1.01)})
        self.assertIn("No candidate passes the image gate on every subject.", output)

    def test_topup_single_does_not_relax_the_ap_pa_limit(self):
        output = self.aggregate({"one": self.rows(appa=1.15, single_appa=1.25)})
        self.assertIn("No candidate passes the image gate on every subject.", output)

    def test_default_cohort_requires_all_six_subjects(self):
        with self.assertRaises(subprocess.CalledProcessError) as error:
            self.aggregate({"ds005134-sub-01": self.rows()}, explicit=False)
        self.assertIn(
            "Missing subject results: ds004146-sub-0001", error.exception.output
        )

    def test_missing_subject_is_not_a_pass(self):
        output = self.aggregate(
            {"one": self.rows(), "two": self.rows(include_candidate=False)}
        )
        self.assertIn("No candidate passes the image gate on every subject.", output)


if __name__ == "__main__":
    unittest.main()
