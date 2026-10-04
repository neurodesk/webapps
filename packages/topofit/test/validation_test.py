import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


PACKAGE = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("activation", PACKAGE / "scripts" / "activate_manifest.py")
activation = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(activation)


class ActivationTest(unittest.TestCase):
    def setUp(self):
        self.work = tempfile.TemporaryDirectory()
        self.addCleanup(self.work.cleanup)
        self.assets = Path(self.work.name)
        self.reports = self.assets / "validation" / "reports"
        self.reports.mkdir(parents=True)
        for mode in ("controlled", "end-to-end"):
            report = json.loads((PACKAGE / "validation" / "results" / f"ds000001-{mode}.json").read_text())
            self.release = report["release"]
            self.conversion = report["conversionReportSha256"]
            browser = self.assets / "validation" / "browser" / mode
            browser.mkdir(parents=True)
            for name in (*activation.SURFACES, "topofit_qc.nii"):
                path = browser / name
                path.write_bytes(f"{mode}/{name}".encode())
                target = report["surfaces"][name] if name in report["surfaces"] else report["qc"]
                target["browser_sha256"] = activation.sha256(path)
            (browser / "topofit_manifest.json").write_text(json.dumps({"runtime": {"release": self.release}}))
            self.write_report(mode, report)

    def write_report(self, mode, report):
        (self.reports / f"ds000001-{mode}.json").write_text(json.dumps(report))

    def change_end_to_end(self, change):
        report = json.loads((self.reports / "ds000001-end-to-end.json").read_text())
        change(report)
        self.write_report("end-to-end", report)

    def validate(self):
        activation.validate_evidence(self.assets, self.release, self.conversion)

    def test_accepts_passing_controlled_and_end_to_end_evidence(self):
        self.validate()

    def test_rejects_measured_difference(self):
        self.change_end_to_end(lambda report: report.update(status="measured-difference"))
        with self.assertRaises(AssertionError):
            self.validate()

    def test_rejects_failed_metrics_even_when_report_claims_passed(self):
        self.change_end_to_end(lambda report: report["surfaces"]["rh.pial"].update(mean_corresponding_distance_mm=1.564))
        with self.assertRaisesRegex(AssertionError, "end-to-end exceeds"):
            self.validate()

    def test_rejects_weakened_mean_threshold(self):
        self.change_end_to_end(lambda report: report["thresholds"].update(surfaceMeanMm=2))
        with self.assertRaises(AssertionError):
            self.validate()

    def test_rejects_missing_anatomical_surface(self):
        self.change_end_to_end(lambda report: report["surfaces"].pop("lh.white"))
        with self.assertRaises(AssertionError):
            self.validate()

    def test_rejects_nonfinite_distance(self):
        self.change_end_to_end(lambda report: report["surfaces"]["rh.pial"].update(mean_corresponding_distance_mm=float("nan")))
        with self.assertRaises(AssertionError):
            self.validate()


if __name__ == "__main__":
    unittest.main()
