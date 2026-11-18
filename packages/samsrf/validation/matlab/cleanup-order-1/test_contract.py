"""Synthetic protocol tests only: never execute the scientific cases in MATLAB."""
import json
import shutil
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import evaluate as gate
import prepare

COMMIT = None


class ContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        global COMMIT
        # An isolated Git fixture seals the current proposal before mutations.
        # It is not a repository worktree or a scientific recording.
        cls.source = gate.HERE
        cls.snapshot = tempfile.TemporaryDirectory(prefix="cleanup-order-git-", dir=os.environ.get("TMPDIR"))
        cls.addClassCleanup(cls.snapshot.cleanup)
        root = Path(cls.snapshot.name)
        c = gate.read(cls.source / "contract.json")
        relative = cls.source.relative_to(cls.source.parents[4])
        for name in [row["path"] for row in c["files"]] + [str(relative / "contract.json")]:
            dest = root / name
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(cls.source.parents[4] / name, dest)
        for command in (["init", "--quiet"], ["add", "."],
                        ["-c", "user.name=Protocol Test", "-c", "user.email=protocol@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "Synthetic protocol trust anchor"]):
            subprocess.run(["git", *command], cwd=root, check=True, capture_output=True)
        COMMIT = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip()
        for module in (gate, prepare):
            patcher = patch.object(module, "HERE", root / relative)
            patcher.start()
            cls.addClassCleanup(patcher.stop)
        cls.contract = gate.contract(COMMIT)
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
                meta = dict(self.contract["matlab"], blas=self.contract["blas_by_vendor"][vendor], threads=1, environment=gate.ENVIRONMENT.copy(),
                            cpu_report=f"Architecture: x86_64\nVendor ID: {vendor}\nModel name: {model_name}\n",
                            process_id=repeat * 100, process_nonce=f"00000000-0000-0000-0000-{repeat:012d}")
                record = {"schema": 1, "repeat": repeat, "context": ctx, "metadata": meta,
                          "cases": [self.case(ident, model) for ident in self.expected]}
                (root / f"record-{repeat}.json").write_text(json.dumps(record))
                self.write_journal(root, repeat, record)

    def write_journal(self, root, repeat, record):
        folder = root / f"process-{repeat}"
        if folder.exists():
            shutil.rmtree(folder)
        folder.mkdir()
        start = dict(schema=1, repeat=repeat, **{key: record["metadata"][key] for key in ("process_id", "process_nonce")})
        receipt = {key: record[key] for key in ("schema", "repeat", "context", "metadata")}
        (folder / "start.json").write_text(json.dumps(start))
        (folder / "receipt.json").write_text(json.dumps(receipt))
        for index, case in enumerate(record["cases"], 1):
            (folder / f"case-{index}.json").write_text(json.dumps(dict(schema=1, repeat=repeat, index=index, case=case)))

    def mutate(self, callback, host=gate.RUNNERS[0], repeats=(1,)):
        for repeat in repeats:
            path = self.root / host / f"record-{repeat}.json"
            value = gate.read(path)
            callback(value)
            path.write_text(json.dumps(value))
            self.write_journal(path.parent, repeat, value)

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
            (lambda r: r["context"].update(input_sha256="0" * 64), "input"),
            (lambda r: r["context"].update(contract_sha256="0" * 64), "contract"),
            (lambda r: r["context"]["source_files"][0].update(sha256="0" * 64), "code hashes"),
            (lambda r: r["context"].update(commit="0" * 40), "commit"),
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
        self.mutate(lambda r: r["metadata"].update(cpu_report="Architecture: x86_64\nVendor ID: AuthenticAMD\nModel name: AMD EPYC\n", blas=self.contract["blas_by_vendor"]["AuthenticAMD"]), host=gate.RUNNERS[1], repeats=(1, 2))
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

    def test_each_nested_context_has_strict_types(self):
        for field in ("schema", "run_attempt"):
            for value in (True, 1.0):
                for location in ("record", "journal"):
                    with self.subTest(field=field, value=value, location=location):
                        self.make_pair()
                        for runner in gate.RUNNERS:
                            if location == "record":
                                self.mutate(lambda r: r["context"].update({field: value}), host=runner, repeats=(1, 2))
                            else:
                                for repeat in (1, 2):
                                    p = self.root / runner / f"process-{repeat}" / "receipt.json"
                                    receipt = gate.read(p)
                                    receipt["context"][field] = value
                                    p.write_text(json.dumps(receipt))
                        self.rejected("integer")

    def test_full_pinned_cpu_receipts_and_vendor_backends(self):
        fixture = gate.read(gate.HERE / "metadata-receipts.json")
        for swapped in (False, True):
            self.make_pair()
            receipts = fixture["receipts"][::-1] if swapped else fixture["receipts"]
            for runner, receipt in zip(gate.RUNNERS, receipts, strict=True):
                values = {k: v for k, v in receipt.items() if not k.startswith("source_")}
                self.mutate(lambda r: r["metadata"].update(values), host=runner, repeats=(1, 2))
            self.assertEqual(gate.decide(self.root, COMMIT)["status"], "diagnostic-supported")
        for vendor in ("AuthenticAMD", "GenuineIntel"):
            for name in ("Architecture", "Vendor ID", "Model name"):
                self.make_pair()
                runner = gate.RUNNERS[("AuthenticAMD", "GenuineIntel").index(vendor)]
                receipt = next(r for r in fixture["receipts"] if vendor in r["cpu_report"])
                line = next(line for line in receipt["cpu_report"].splitlines() if line.lstrip().startswith(name + ":"))
                self.mutate(lambda r: r["metadata"].update(cpu_report=receipt["cpu_report"] + line + "\n"), host=runner)
                self.rejected("CPU receipt")
            for backend in ("unknown", self.contract["blas_by_vendor"]["GenuineIntel" if vendor == "AuthenticAMD" else "AuthenticAMD"]):
                self.make_pair()
                self.mutate(lambda r: r["metadata"].update(blas=backend), host=runner, repeats=(1, 2))
                self.rejected("blas")

    def test_git_anchor_rejects_coordinated_mutations(self):
        for changed in ("record_cleanup_order.m", "predictions.json", "contract.json", "evaluate.py"):
            with self.subTest(changed=changed):
                self.make_pair()
                mutation = self.root / "mutated-source"
                if mutation.exists():
                    shutil.rmtree(mutation)
                shutil.copytree(gate.HERE.parents[4], mutation)
                folder = mutation / gate.HERE.relative_to(gate.HERE.parents[4])
                c = gate.read(folder / "contract.json")
                path = folder / changed
                if changed == "predictions.json":
                    predictions = gate.read(path)
                    word = predictions["cases"][0]["preclean_model"]["estimate_bits"][0]
                    replacement = f"{int(word, 16) ^ 1:016x}"
                    predictions["cases"][0]["preclean_model"]["estimate_bits"][0] = replacement
                    path.write_text(json.dumps(predictions))
                    for runner in gate.RUNNERS:
                        self.mutate(lambda r: r["cases"][0]["estimate"]["bits"].__setitem__(0, replacement), host=runner, repeats=(1, 2))
                elif changed == "contract.json":
                    c["planned_budget"]["dispatches"] = 999
                else:
                    path.write_text(path.read_text() + ("\n% changed\n" if changed.endswith(".m") else "\n# changed\n"))
                for row in c["files"]:
                    row["sha256"] = gate.sha(mutation / row["path"])
                (folder / "contract.json").write_text(json.dumps(c))
                for runner in gate.RUNNERS:
                    path = self.root / runner / "context.json"
                    ctx = gate.read(path)
                    ctx.update(source_files=c["files"], contract_sha256=gate.sha(folder / "contract.json"))
                    path.write_text(json.dumps(ctx))
                    self.mutate(lambda r: r.update(context=ctx), host=runner, repeats=(1, 2))
                with patch.object(gate, "HERE", folder):
                    self.rejected("contract differs from reviewed commit")
                run = subprocess.run([sys.executable, str(folder / "evaluate.py"), "pair", str(self.root), "--commit", COMMIT], capture_output=True, text=True)
                self.assertEqual(run.returncode, 1, run.stdout)
                self.assertIn("contract differs from reviewed commit", json.loads(run.stdout)["reason"])
                shutil.rmtree(mutation)
        self.make_pair()
        with self.assertRaisesRegex(gate.Invalid, "unavailable"):
            gate.decide(self.root, "1" * 40)
        # Even an untouched contract cannot hide dirty recorder bytes.
        mutation = self.root / "mutated-source"
        shutil.copytree(gate.HERE.parents[4], mutation)
        folder = mutation / gate.HERE.relative_to(gate.HERE.parents[4])
        recorder = folder / "record_cleanup_order.m"
        recorder.write_text(recorder.read_text() + "\n% changed without rehashing\n")
        with patch.object(gate, "HERE", folder):
            self.rejected("source differs from reviewed commit")
        shutil.rmtree(mutation)


    def test_partial_failure_inventory_is_preserved_and_rejected(self):
        for completed in (0, 3, 7):
            self.make_pair()
            root = self.root / gate.RUNNERS[0]
            folder = root / "process-1"
            for index in range(completed + 1, 8):
                (folder / f"case-{index}.json").unlink()
            failure = dict(schema=1, repeat=1, stage="case", case_index=completed + 1,
                           case_id="synthetic", completed_cases=list(self.expected)[:completed],
                           error_id="synthetic:Failure", error_message="stub failure", error_report="no MATLAB executed")
            (folder / "failure.json").write_text(json.dumps(failure))
            before = {p: p.read_bytes() for p in folder.iterdir()}
            self.rejected("evidence inventory")
            self.assertEqual(before, {p: p.read_bytes() for p in folder.iterdir()})
        self.make_pair()
        folder = self.root / gate.RUNNERS[0] / "process-1"
        for path in folder.iterdir():
            if path.name != "start.json":
                path.unlink()
        self.rejected("evidence inventory")
        for name in ("start.json", "receipt.json", "case-1.json"):
            self.make_pair()
            path = self.root / gate.RUNNERS[0] / "process-1" / name
            obj = gate.read(path)
            obj["schema"] = True
            path.write_text(json.dumps(obj))
            self.rejected("integer")
        self.make_pair()
        path = self.root / gate.RUNNERS[0] / "process-1" / "case-1.json"
        obj = gate.read(path)
        obj["case"]["estimate"]["bits"][0] = "3ff0000000000000"
        path.write_text(json.dumps(obj))
        self.rejected("evidence differs")
        self.make_pair()
        obj = gate.read(path)
        obj["case"]["estimate"]["shape"] = [1.0, 3]
        path.write_text(json.dumps(obj))
        self.rejected("integer")

    def test_recorder_journal_control_flow_static_only(self):
        source = (gate.HERE / "record_cleanup_order.m").read_text()
        start = source.index("writeJson(fullfile(evidenceDirectory, 'start.json')")
        receipt = source.index("writeJson(fullfile(evidenceDirectory, 'receipt.json')")
        validate = source.index("stage = 'input-validation'")
        compute = source.index("shape = polyshape(item.P)")
        saved = source.index("writeJson(fullfile(evidenceDirectory, sprintf('case-%d.json'")
        final = source.index("stage = 'final-record'")
        self.assertTrue(start < receipt < validate < compute < saved < final)
        self.assertIn("catch failure", source)
        self.assertIn("writeJson(fullfile(evidenceDirectory, 'failure.json'), evidence)", source)
        self.assertIn("rethrow(failure)", source)
        self.assertIn("closeOutput = onCleanup(@() fclose(fid))", source)


if __name__ == "__main__":
    unittest.main()
