"""Check that a failed optional method leaves the other subject results available."""

import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("post.sh")


class PostWorkflowTests(unittest.TestCase):
    def score(self, failed_method="failed", failed_stage="fields", baseline=True):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            scripts = root / "scripts"
            scripts.mkdir()
            local_script = scripts / "post.sh"
            local_script.write_text(SCRIPT.read_text())
            (scripts / "common.sh").write_text(
                'py() { python3 "$@"; }\nfsl() { printf "0.9\\n"; }\n'
            )
            failure = f"import sys\nif sys.argv[2] == {failed_method!r}: raise SystemExit(1)\n"
            (scripts / "fields.py").write_text(
                failure if failed_stage == "fields" else ""
            )
            (scripts / "evaluate.py").write_text(
                (failure if failed_stage == "evaluate" else "")
                + "import json,sys\nfrom pathlib import Path\n"
                "run,method=sys.argv[1:]\n"
                '(Path(run)/method/"metrics.json").write_text('
                'json.dumps({"method":method}))\n'
            )
            run = root / "runs" / "subject"
            for name in ["topup", "failed", "completed", "mask"]:
                if name != "topup" or baseline:
                    (run / name).mkdir(parents=True)
            for path in [
                run / "calibration.json",
                run / "mask" / "b0_mask.nii.gz",
                run / "mask" / "b0_to_t1w_init.mat",
            ]:
                path.touch()
            env = {**os.environ, "ROOT": str(root), "SCRIPTS": str(scripts)}
            result = subprocess.run(
                ["bash", str(local_script), "subject", "failed", "completed"],
                env=env,
                text=True,
                capture_output=True,
            )
            summary = run / "summary.json"
            rows = json.loads(summary.read_text()) if summary.exists() else None
            return result, rows

    def test_failed_method_does_not_hide_completed_methods(self):
        result, rows = self.score()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual([row["method"] for row in rows], ["completed", "topup"])
        self.assertIn("Skipping failed method failed", result.stderr)

    def test_missing_baseline_stops_post_processing(self):
        result, rows = self.score(baseline=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIsNone(rows)
        self.assertIn("Reference method topup is missing", result.stderr)

    def test_failed_baseline_stops_post_processing(self):
        for stage in ["fields", "evaluate"]:
            with self.subTest(stage=stage):
                result, rows = self.score(failed_method="topup", failed_stage=stage)
                self.assertNotEqual(result.returncode, 0)
                self.assertIsNone(rows)
                self.assertIn("Reference method topup failed", result.stderr)


if __name__ == "__main__":
    unittest.main()
