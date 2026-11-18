"""Synthetic protocol tests only: never execute the scientific cases in MATLAB."""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import evaluate as gate
import prepare

COMMIT = "a" * 40


class ContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.contract = gate.contract()
        cls.expected, cls.control = gate.expectations()

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="cleanup-order-test-", dir=os.environ.get("TMPDIR"))
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.make_pair()

    def context(self, runner):
        env = dict(gate.ENVIRONMENT, GITHUB_EVENT_NAME="workflow_dispatch", GITHUB_RUN_ATTEMPT="1", GITHUB_SHA=COMMIT,
                   GITHUB_RUN_ID="123", GITHUB_REPOSITORY="neurodesk/webapps",
                   GITHUB_WORKFLOW_REF="neurodesk/webapps/.github/workflows/samsrf-native.yml@refs/heads/test")
        return prepare.make_context(env, {"inputs": {"record_matlab": "true", "probes": gate.ROUND, "include_matrix": "false"}}, runner, self.contract)

    def case(self, ident, model):
        inp, pred = self.expected[ident]
        control = ident.startswith("seen-")
        shape = self.control["matlab_shape_bits"] if control else pred["shape_prediction_bits"][0]
        hull = self.control["matlab_hull_bits"] if control else pred[model]["hull_bits"]
        estimate = self.control["matlab_estimate_bits"] if control else pred[model]["estimate_bits"]
        return {"id": ident, "points": gate.matrix(inp["points_bits"]), "shape": gate.matrix(shape), "hull": gate.matrix(hull),
                "estimate": gate.matrix([estimate]), "warning_id": "", "warning_message": ""}

    def make_pair(self, model="preclean_model"):
        for host, vendor, model_name in zip(gate.RUNNERS, ("AuthenticAMD", "GenuineIntel"), ("AMD EPYC", "Intel Xeon")):
            root = self.root / host
            root.mkdir(exist_ok=True)
            ctx = self.context(host)
            (root / "context.json").write_text(json.dumps(ctx))
            for repeat in (1, 2):
                meta = dict(self.contract["matlab"], threads=1, environment=gate.ENVIRONMENT.copy(),
                            cpu_report=f"Architecture: x86_64\nVendor ID: {vendor}\nModel name: {model_name}\n",
                            process_id=repeat * 100, process_nonce=f"00000000-0000-0000-0000-{repeat:012d}")
                record = {"schema": 1, "repeat": repeat, "context": ctx, "metadata": meta,
                          "cases": [self.case(ident, model) for ident in self.expected]}
                (root / f"record-{repeat}.json").write_text(json.dumps(record))

    def mutate(self, callback, host=gate.RUNNERS[0], repeats=(1,)):
        for repeat in repeats:
            path = self.root / host / f"record-{repeat}.json"
            value = gate.read(path)
            callback(value)
            path.write_text(json.dumps(value))

    def rejected(self, pattern):
        with self.assertRaisesRegex(gate.Invalid, pattern):
            gate.decide(self.root, COMMIT)

    def test_each_model_can_win_without_approving_production(self):
        for model in gate.MODELS:
            with self.subTest(model=model):
                self.make_pair(model)
                result = gate.decide(self.root, COMMIT)
                self.assertEqual(result["model"], model)
                self.assertFalse(result["production_approval"])

    def test_literal_signed_zero_is_not_normalized(self):
        # The frozen cases have no zero coordinate. Both valid finite encodings
        # are nevertheless distinct at the boundary's literal comparator.
        a = {"class": "double", "shape": [1, 1], "bits": ["0000000000000000"]}
        b = {"class": "double", "shape": [1, 1], "bits": ["8000000000000000"]}
        self.assertNotEqual(gate.array(a, [1, 1], "zero"), gate.array(b, [1, 1], "zero"))

    def test_bad_inventory_types_dimensions_and_bits(self):
        mutations = [
            (lambda r: r.update(extra=1), "fields"),
            (lambda r: r.update(schema=True), "integer"),
            (lambda r: r.update(repeat=1.0), "integer"),
            (lambda r: r["cases"].pop(), "seven cases"),
            (lambda r: r["cases"].append(r["cases"][0]), "seven cases"),
            (lambda r: r["cases"][1].update(id=r["cases"][0]["id"]), "duplicate case"),
            (lambda r: r["cases"][0].update(id="invented"), "unknown/duplicate"),
            (lambda r: r["cases"][0].update(extra=1), "fields"),
            (lambda r: r["cases"][0]["hull"].update(**{"class": "single"}), "class"),
            (lambda r: r["cases"][0]["hull"].update(shape=[5, 2]), "shape"),
            (lambda r: r["cases"][0]["hull"].update(shape=[4.0, 2]), "integer"),
            (lambda r: r["cases"][0]["hull"].update(shape=[True, 2]), "integer"),
            (lambda r: r["cases"][0]["hull"]["bits"].pop(), "bit count"),
            (lambda r: r["cases"][0]["hull"]["bits"].__setitem__(0, "nan"), "IEEE"),
            (lambda r: r["cases"][0]["hull"]["bits"].__setitem__(0, 0), "IEEE"),
            (lambda r: r["cases"][0]["hull"]["bits"].__setitem__(0, "BFF4000000000000"), "IEEE"),
            (lambda r: r["cases"][0]["hull"]["bits"].__setitem__(0, "7ff0000000000000"), "nonfinite"),
            (lambda r: r["cases"][0]["estimate"]["bits"].__setitem__(0, "7ff8000000000000"), "nonfinite"),
            (lambda r: r["cases"][0]["points"]["bits"].__setitem__(0, "8000000000000000"), "points bits"),
            (lambda r: r["cases"][0]["shape"]["bits"].reverse(), "shape bits"),
            (lambda r: r["cases"][0].update(warning_id="unexpected"), "warning"),
        ]
        for change, reason in mutations:
            with self.subTest(reason=reason, change=change):
                self.make_pair()
                self.mutate(change)
                self.rejected(reason)

    def test_metadata_and_receipt_mutants(self):
        changes = [
            (lambda r: r["metadata"].update(matlab_version="different"), "version"),
            (lambda r: r["metadata"].update(release="2024a"), "release"),
            (lambda r: r["metadata"].update(blas=""), "blas"),
            (lambda r: r["metadata"].update(computer="MACI64"), "computer"),
            (lambda r: r["metadata"].update(threads=1.0), "integer"),
            (lambda r: r["metadata"].update(cpu_report=""), "CPU"),
            (lambda r: r["metadata"].update(cpu_report="Architecture: x86_64\nVendor ID: AuthenticAMD\nVendor ID: AuthenticAMD\nModel name: AMD\n"), "Vendor"),
            (lambda r: r["metadata"].update(process_id=True), "process id"),
            (lambda r: r["metadata"].update(process_nonce=""), "nonce"),
            (lambda r: r["metadata"]["environment"].update(MKL_CBWR="AUTO"), "environment"),
            (lambda r: r["context"].update(input_sha256="0" * 64), "context"),
            (lambda r: r["context"].update(contract_sha256="0" * 64), "context"),
            (lambda r: r["context"]["source_files"][0].update(sha256="0" * 64), "context"),
            (lambda r: r["context"].update(commit="0" * 40), "context"),
        ]
        for change, reason in changes:
            with self.subTest(reason=reason):
                self.make_pair()
                self.mutate(change)
                self.rejected(reason)

    def test_context_cannot_be_forged_consistently(self):
        for field, value, reason in [("input_sha256", "0" * 64, "input"), ("contract_sha256", "0" * 64, "contract"),
                                      ("commit", "0" * 40, "commit"), ("run_attempt", 2, "attempt"),
                                      ("schema", True, "integer"), ("runner", "ubuntu-26.04", "runner")]:
            with self.subTest(field=field):
                self.make_pair()
                path = self.root / gate.RUNNERS[0] / "context.json"
                ctx = gate.read(path)
                ctx[field] = value
                path.write_text(json.dumps(ctx))
                self.mutate(lambda r: r.update(context=ctx), repeats=(1, 2))
                self.rejected(reason)

    def test_same_process_receipt_is_rejected(self):
        for field in ("process_id", "process_nonce"):
            self.make_pair()
            first = gate.read(self.root / gate.RUNNERS[0] / "record-1.json")["metadata"][field]
            self.mutate(lambda r: r["metadata"].update({field: first}), repeats=(2,))
            self.rejected("fresh processes")

    def test_nan_payload_of_exposed_control_is_literal(self):
        def change(r):
            bits = r["cases"][-1]["shape"]["bits"]
            index = next(i for i, word in enumerate(bits) if (int(word, 16) & 0x7ff0000000000000) == 0x7ff0000000000000)
            bits[index] = f"{int(bits[index], 16) ^ 1:016x}"
        self.mutate(change, repeats=(1, 2))
        self.rejected("shape bits")

    def test_exposed_control_uses_matlab_not_wrong_native_rings(self):
        pred = list(self.expected.values())[-1][1]
        self.assertEqual(len(pred["shape_prediction_bits"]), 2)
        self.mutate(lambda r: r["cases"][-1].update(shape=gate.matrix(pred["shape_prediction_bits"][0])))
        self.rejected("shape")

    def test_order_anchor_is_not_normalized_away(self):
        for runner in gate.RUNNERS:
            self.mutate(lambda r: r["cases"][0]["hull"]["bits"].reverse(), host=runner, repeats=(1, 2))
        self.rejected("no unique model")

    def test_repeat_cross_host_and_vendor_failures(self):
        self.mutate(lambda r: r["cases"][0]["estimate"]["bits"].__setitem__(0, "3ff0000000000000"))
        self.rejected("repeat bits")
        self.make_pair()
        self.mutate(lambda r: r["cases"].__setitem__(0, self.case(r["cases"][0]["id"], "survivor_model")), repeats=(1, 2))
        self.rejected("cross-host")
        self.make_pair()
        self.mutate(lambda r: r["metadata"].update(cpu_report="Architecture: x86_64\nVendor ID: AuthenticAMD\nModel name: AMD EPYC\n"), host=gate.RUNNERS[1], repeats=(1, 2))
        self.rejected("AMD\\+Intel")

    def test_missing_extra_files_and_duplicate_json_keys(self):
        path = self.root / gate.RUNNERS[0] / "record-2.json"
        path.unlink()
        self.rejected("inventory")
        self.make_pair()
        (self.root / gate.RUNNERS[0] / "extra.json").write_text("{}")
        self.rejected("inventory")
        (self.root / gate.RUNNERS[0] / "extra.json").unlink()
        path.write_text(path.read_text().replace('"schema": 1', '"schema": 1, "schema": 1', 1))
        self.rejected("duplicate JSON")

    def test_cli_reports_stop_and_does_not_mutate_inputs(self):
        path = self.root / gate.RUNNERS[0] / "record-2.json"
        path.unlink()
        before = {str(p): p.read_bytes() for p in self.root.rglob("*.json")}
        run = subprocess.run([sys.executable, str(gate.HERE / "evaluate.py"), "pair", str(self.root), "--commit", COMMIT], capture_output=True, text=True)
        self.assertEqual(run.returncode, 1)
        self.assertEqual(json.loads(run.stdout)["status"], "undecided-stop")
        self.assertEqual(before, {str(p): p.read_bytes() for p in self.root.rglob("*.json")})

    def test_preparation_refuses_actual_event_misconfiguration(self):
        env = dict(gate.ENVIRONMENT, GITHUB_EVENT_NAME="workflow_dispatch", GITHUB_RUN_ATTEMPT="1", GITHUB_SHA=COMMIT,
                   GITHUB_RUN_ID="123", GITHUB_REPOSITORY="neurodesk/webapps",
                   GITHUB_WORKFLOW_REF="neurodesk/webapps/.github/workflows/samsrf-native.yml@refs/heads/test")
        selected = {"record_matlab": "true", "probes": gate.ROUND, "include_matrix": "false"}
        for name, value in [("include_matrix", "true"), ("wasm_only", "true"), ("runtime_cli", "source"),
                            ("sign_release", "true"), ("record_matlab", 1), ("unrecognized", "false")]:
            with self.subTest(name=name):
                with self.assertRaises(gate.Invalid):
                    prepare.make_context(env, {"inputs": dict(selected, **{name: value})}, gate.RUNNERS[0], self.contract)
        for name, value in [("GITHUB_RUN_ATTEMPT", "2"), ("GITHUB_EVENT_NAME", "push"), ("MKL_CBWR", "AUTO")]:
            with self.assertRaises(gate.Invalid):
                prepare.make_context(dict(env, **{name: value}), {"inputs": selected}, gate.RUNNERS[0], self.contract)


if __name__ == "__main__":
    unittest.main()
