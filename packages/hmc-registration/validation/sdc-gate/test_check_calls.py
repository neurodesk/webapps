"""Cheap completeness/provenance regression tests; no scientific programs run."""

import copy
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("check_calls.py")
HASH = "a" * 64
REPLAY = [("ImageMath", "syn_sdc_wf/lap_anat"), ("ImageMath", "syn_sdc_wf/lap_epi"),
          ("antsApplyTransforms", "syn_sdc_wf/amask2epi"), ("antsRegistration", "syn_sdc_wf/syn"),
          ("antsApplyTransforms", "syn_sdc_wf/zooms_field"), ("antsApplyTransforms", "syn_sdc_wf/zooms_bmask")]
E2E = REPLAY + [("DenoiseImage", "syn_preprocessing_wf/ref_anat"),
                ("antsRegistration", "syn_preprocessing_wf/epi2anat"),
                ("antsApplyTransforms", "syn_preprocessing_wf/anat2epi"),
                ("antsApplyTransforms", "syn_preprocessing_wf/mask2epi"),
                ("antsApplyTransforms", "syn_preprocessing_wf/prior2epi")]


class CallValidation(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.run_path = Path(self.directory.name).resolve()

    def fixture(self, nodes=E2E):
        timed, kernel = [], []
        for tool, node in nodes:
            cwd = str(self.run_path / "work/sdc_ref" / node)
            timed.append({"tool": tool, "cwd": cwd, "argv": ["3"], "exit": 0, "wall_s": 1,
                          "max_rss_kb": 1024, "command": "DenoiseImage" if tool == "DenoiseImage" else "node ants-cli.mjs"})
            if tool != "DenoiseImage":
                kernel.append({"program": tool, "cwd": cwd, "argv": ["3"], "wasm_sha256": HASH,
                               "exit": 0, "error": None, "wasm_heap_bytes": 268435456})
        return timed, kernel

    def check(self, records, *args):
        for name, rows in zip(["ants-calls.jsonl", "wasm-calls.jsonl"], records):
            (self.run_path / name).write_text("".join(json.dumps(c) + "\n" for c in rows))
        done = subprocess.run([sys.executable, "-I", str(SCRIPT), str(self.run_path), HASH, *args],
                              text=True, capture_output=True, check=False)
        result = json.loads(done.stdout)
        self.assertEqual(done.returncode == 0, not result["problems"])
        return done.returncode

    def test_complete_e2e_and_replay(self):
        self.assertEqual(self.check(self.fixture()), 0)
        self.assertEqual(self.check(self.fixture(REPLAY), "--mode", "replay"), 0)
        self.assertNotEqual(self.check(self.fixture(REPLAY)), 0)

    def test_empty_or_missing_workflow_nodes(self):
        self.assertNotEqual(self.check(([], [])), 0)
        a, b = self.fixture()
        self.assertNotEqual(self.check(([c for c in a if not c["cwd"].endswith("/epi2anat")],
                                        [c for c in b if not c["cwd"].endswith("/epi2anat")])), 0)

    def test_kernel_failures_and_provenance(self):
        for change in [{"exit": 1}, {"error": "kernel failure"}, {"wasm_sha256": "b" * 64},
                       {"cwd": "/foreign/run/lap_anat"}, {"argv": []}]:
            with self.subTest(change=change):
                a, b = self.fixture()
                b[0].update(change)
                self.assertNotEqual(self.check((a, b)), 0)

    def test_missing_or_duplicate_kernel_records(self):
        a, b = self.fixture()
        self.assertNotEqual(self.check((a, b[1:])), 0)
        self.assertNotEqual(self.check((a, b + [copy.deepcopy(b[0])])), 0)
        self.assertNotEqual(self.check((a + [copy.deepcopy(a[0])], b + [copy.deepcopy(b[0])])), 0)

    def test_wrapper_failures_and_native_calls(self):
        for change in [{"exit": 1}, {"command": "native-ants"}, {"cwd": "/foreign/run/lap_anat"}]:
            with self.subTest(change=change):
                a, b = self.fixture()
                a[0].update(change)
                self.assertNotEqual(self.check((a, b)), 0)

    def test_record_order_does_not_change_call_identity(self):
        a, b = self.fixture()
        self.assertEqual(self.check((a, b[::-1])), 0)


if __name__ == "__main__":
    unittest.main()
