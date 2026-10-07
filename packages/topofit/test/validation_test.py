import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


PACKAGE = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("activation", PACKAGE / "scripts" / "activate_manifest.py")
activation = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(activation)
COMPARE_SPEC = importlib.util.spec_from_file_location("compare", PACKAGE / "validation" / "compare.py")
compare = importlib.util.module_from_spec(COMPARE_SPEC)
COMPARE_SPEC.loader.exec_module(compare)


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
            for name in activation.BASELINE_OUTPUTS:
                path = browser / name
                path.write_bytes(f"{mode}/{name}".encode())
                report["baseline"]["outputSha256"][name] = activation.sha256(path)
                if name in report["surfaces"]:
                    report["surfaces"][name]["browser_sha256"] = activation.sha256(path)
                elif name == "topofit_qc.nii":
                    report["qc"]["browser_sha256"] = activation.sha256(path)
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

    def test_rejects_outputs_that_left_the_pinned_baseline(self):
        self.change_end_to_end(lambda report: report["baseline"].update(byteIdentical=False, changed=["rh.pial"]))
        with self.assertRaisesRegex(AssertionError, "end-to-end outputs differ from the pinned baseline"):
            self.validate()

    def test_rejects_mid_surface_evidence_that_does_not_match(self):
        (self.assets / "validation" / "browser" / "end-to-end" / "lh.mid.white").write_bytes(b"moved")
        with self.assertRaisesRegex(AssertionError, "end-to-end evidence for lh.mid.white does not match"):
            self.validate()

    def test_rejects_a_single_run_without_a_repeat(self):
        self.change_end_to_end(lambda report: report.update(repeatability=[]))
        with self.assertRaisesRegex(AssertionError, "end-to-end has no repeat run"):
            self.validate()

    def test_rejects_nonfinite_distance(self):
        self.change_end_to_end(lambda report: report["surfaces"]["rh.pial"].update(mean_corresponding_distance_mm=float("nan")))
        with self.assertRaises(AssertionError):
            self.validate()


class BaselineTest(unittest.TestCase):
    def setUp(self):
        self.work = tempfile.TemporaryDirectory()
        self.addCleanup(self.work.cleanup)
        self.browser = Path(self.work.name)
        for name in compare.BASELINE_OUTPUTS:
            (self.browser / name).write_bytes(name.encode())
        self.pinned = {name: compare.sha256(self.browser / name) for name in compare.BASELINE_OUTPUTS}

    def test_accepts_byte_identical_outputs(self):
        self.assertEqual(compare.compare_baseline(self.browser, self.pinned)["changed"], [])

    def test_names_each_output_that_moved(self):
        (self.browser / "rh.pial").write_bytes(b"one float moved")
        (self.browser / "lh.mid.white").write_bytes(b"derived surface moved")
        result = compare.compare_baseline(self.browser, self.pinned)
        self.assertFalse(result["byteIdentical"])
        self.assertEqual(result["changed"], ["lh.mid.white", "rh.pial"])

    def test_every_mode_pins_every_baseline_output_and_reference_surface(self):
        for fixture in compare.INPUTS.values():
            self.assertEqual(set(fixture["outputSha256"]), set(compare.BASELINE_OUTPUTS))
            self.assertEqual(set(fixture["referenceGeometrySha256"]), set(compare.SURFACES))

    def test_reference_geometry_ignores_creation_stamp(self):
        import nibabel as nib
        import numpy as np

        vertices = np.arange(12, dtype=np.float64).reshape(4, 3)
        faces = np.array([[0, 1, 2], [0, 2, 3]], dtype=np.int32)
        first = self.browser / "first"
        second = self.browser / "second"
        nib.freesurfer.write_geometry(first, vertices, faces, create_stamp="created by topofit on Mon")
        nib.freesurfer.write_geometry(second, vertices, faces, create_stamp="created by topofit on Tue")
        self.assertNotEqual(compare.sha256(first), compare.sha256(second))
        self.assertEqual(compare.geometry_sha256(first), compare.geometry_sha256(second))
        vertices[3, 2] = np.nextafter(np.float32(11), np.float32(12))
        nib.freesurfer.write_geometry(second, vertices, faces, create_stamp="created by topofit on Tue")
        self.assertNotEqual(compare.geometry_sha256(first), compare.geometry_sha256(second))


if __name__ == "__main__":
    unittest.main()
