"""Read-only decision gate for cleanup-order-1. No fitting or tolerance comparisons."""
import argparse
import hashlib
import json
import math
import re
import struct
import subprocess
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROUND = "cleanup-order-1"
RUNNERS = ("ubuntu-22.04", "ubuntu-24.04")
ENVIRONMENT = {"MKL_CBWR": "COMPATIBLE", "MKL_NUM_THREADS": "1", "OMP_NUM_THREADS": "1", "MKL_DYNAMIC": "FALSE", "OMP_DYNAMIC": "FALSE"}
HEX = re.compile(r"[0-9a-f]{16}\Z")
COMMIT = re.compile(r"[0-9a-f]{40}\Z")
MODELS = ("survivor_model", "preclean_model")


class Invalid(ValueError):
    pass


def require(ok, message):
    if not ok:
        raise Invalid(message)


def fields(obj, names, where):
    require(type(obj) is dict and set(obj) == set(names), f"{where}: unexpected/missing fields")


def integer(value, low, high, where):
    require(type(value) is int and low <= value <= high, f"{where}: integer required")


def text(value, pattern, where):
    require(type(value) is str and re.fullmatch(pattern, value), f"{where}: invalid text")


def _pairs(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, f"duplicate JSON key: {key}")
        result[key] = value
    return result


def read(path):
    def invalid_constant(value):
        raise Invalid(f"non-JSON constant: {value}")
    return json.loads(Path(path).read_text(encoding="utf-8"), object_pairs_hook=_pairs, parse_constant=invalid_constant)


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def contract(commit):
    """Authenticate local protocol bytes against independently supplied Git identity.

    --commit must come from the reviewed dispatch, never from a downloaded receipt.
    Git objects seal the contract as well as every file in its source inventory.
    """
    text(commit, COMMIT.pattern, "expected commit")
    root = HERE.parents[4]

    def git(*args):
        run = subprocess.run(["git", "--no-replace-objects", *args], cwd=root, capture_output=True)
        require(run.returncode == 0, "reviewed commit/source unavailable in Git objects")
        return run.stdout

    require(git("cat-file", "-t", commit).strip() == b"commit", "reviewed identity must be a Git commit")
    contract_path = (HERE / "contract.json").relative_to(root).as_posix()
    require(git("show", f"{commit}:{contract_path}") == (HERE / "contract.json").read_bytes(),
            "contract differs from reviewed commit")
    c = read(HERE / "contract.json")
    for row in c["files"]:
        committed = git("show", f"{commit}:{row['path']}")
        require(hashlib.sha256(committed).hexdigest() == row["sha256"], f"reviewed source hash: {row['path']}")
        require(committed == (root / row["path"]).read_bytes(), f"source differs from reviewed commit: {row['path']}")
    require(c["round"] == ROUND, "wrong contract round")
    return c


def matrix(rows):
    """The recorder writes IEEE-754 hex in MATLAB column-major order."""
    require(type(rows) is list and rows, "empty expected matrix")
    columns = len(rows[0])
    require(all(type(r) is list and len(r) == columns for r in rows), "ragged expected matrix")
    return {"class": "double", "shape": [len(rows), columns], "bits": [r[k] for k in range(columns) for r in rows]}


def array(value, shape, where, allow_nonfinite=False):
    fields(value, ("class", "shape", "bits"), where)
    require(value["class"] == "double", f"{where}: class must be double")
    require(type(value["shape"]) is list and len(value["shape"]) == 2, f"{where}: two dimensions required")
    for v in value["shape"]:
        integer(v, 0, 1000, f"{where}: dimension")
    require(value["shape"] == shape, f"{where}: wrong shape")
    require(type(value["bits"]) is list and len(value["bits"]) == math.prod(shape), f"{where}: wrong bit count")
    for word in value["bits"]:
        require(type(word) is str and HEX.fullmatch(word), f"{where}: lowercase IEEE-754 hex required")
        finite = math.isfinite(struct.unpack(">d", bytes.fromhex(word))[0])
        require(allow_nonfinite or finite, f"{where}: unexpected nonfinite value")
    return value


def context(value, runner, commit, c):
    fields(value, ("schema", "round", "base_commit", "commit", "runner", "repository", "workflow_ref", "run_id", "run_attempt", "contract_sha256", "source_files", "input_sha256", "requested_environment"), "context")
    integer(value["schema"], 1, 1, "schema")
    integer(value["run_attempt"], 1, 1, "run attempt (no retry)")
    text(value["run_id"], r"[1-9][0-9]*", "run id")
    text(value["commit"], COMMIT.pattern, "commit")
    require(value["commit"] == commit and value["base_commit"] == c["base_commit"], "wrong commit")
    require(value["round"] == ROUND and value["runner"] == runner, "wrong round/runner")
    require(value["repository"] == "neurodesk/webapps", "wrong repository")
    text(value["workflow_ref"], r"neurodesk/webapps/\.github/workflows/samsrf-native\.yml@refs/heads/[^\s]+", "workflow ref")
    require(value["contract_sha256"] == sha(HERE / "contract.json"), "wrong contract hash")
    require(value["source_files"] == c["files"], "wrong code hashes")
    require(value["input_sha256"] == sha(HERE / "inputs.tsv"), "wrong input-byte hash")
    require(value["requested_environment"] == ENVIRONMENT, "wrong requested environment")


def metadata(value, c):
    fields(value, ("matlab_version", "release", "computer", "blas", "threads", "environment", "cpu_report", "process_id", "process_nonce"), "metadata")
    for key in ("matlab_version", "release", "computer"):
        require(value[key] == c["matlab"][key], f"wrong MATLAB {key}")
    integer(value["threads"], 1, 1, "computational threads")
    integer(value["process_id"], 1, 2**31 - 1, "process id")
    text(value["process_nonce"], r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", "process nonce")
    fields(value["environment"], ENVIRONMENT, "observed environment")
    for key, expected in ENVIRONMENT.items():
        allowed = ("", "1") if key == "MKL_NUM_THREADS" else (expected,)
        require(type(value["environment"][key]) is str and value["environment"][key] in allowed, f"observed environment: {key}")
    report = value["cpu_report"]
    require(type(report) is str and 0 < len(report) < 50000, "CPU receipt missing/oversized")
    def cpu_field(name):
        matches = re.findall(r"^[ \t]*" + re.escape(name) + r":[ \t]*([^\r\n]+)$", report, re.M)
        require(len(matches) == 1, f"CPU receipt: {name}")
        return matches[0].strip()
    vendor, model = cpu_field("Vendor ID"), cpu_field("Model name")
    require(cpu_field("Architecture") == "x86_64", "CPU architecture")
    require(vendor in ("AuthenticAMD", "GenuineIntel"), "CPU vendor outside preselected pair")
    require((vendor == "AuthenticAMD" and "AMD" in model) or (vendor == "GenuineIntel" and "Intel" in model), "CPU model/vendor mismatch")
    require(value["blas"] == c["blas_by_vendor"][vendor], "wrong MATLAB blas for actual CPU vendor")
    return vendor, model


def expectations():
    inputs = read(HERE / "inputs.json")["cases"]
    predictions = read(HERE / "predictions.json")["cases"]
    control = read(HERE / "control.json")
    return {i["id"]: (i, p) for i, p in zip(inputs, predictions, strict=True)}, control


def cases(value, expected, control):
    require(type(value) is list and len(value) == 7, "exactly seven cases per fresh process")
    found = {}
    for item in value:
        fields(item, ("id", "points", "shape", "hull", "estimate", "warning_id", "warning_message"), "case")
        ident = item["id"]
        require(type(ident) is str and ident in expected and ident not in found, "unknown/duplicate case id")
        inp, pred = expected[ident]
        positive = ident == "seen-polygon-point-clouds-48"
        shapes = control["matlab_shape_bits"] if positive else pred["shape_prediction_bits"][0]
        hull = control["matlab_hull_bits"] if positive else pred[MODELS[0]]["hull_bits"]
        wanted = {"points": matrix(inp["points_bits"]), "shape": matrix(shapes), "hull": matrix(hull), "estimate": matrix([control["matlab_estimate_bits"]]) if positive else None}
        for name in ("points", "shape", "hull", "estimate"):
            size = [1, 3] if name == "estimate" else wanted[name]["shape"]
            array(item[name], size, f"{ident}/{name}", positive and name == "shape")
        for name in ("points", "shape"):
            require(item[name] == wanted[name], f"{ident}: unexpected {name} bits; mechanism not isolated")
        if positive:
            for name in ("hull", "estimate"):
                require(item[name] == wanted[name], f"exposed control {name}: differs from pinned MATLAB")
        for name in ("warning_id", "warning_message"):
            require(type(item[name]) is str and len(item[name]) <= 20000, f"{ident}: warning receipt")
        require(positive or not item["warning_id"] and not item["warning_message"], f"{ident}: unexpected warning")
        found[ident] = item
    require(set(found) == set(expected), "case inventory")
    return found


def journal(root, repeat, record, runner, commit, c, expected, control):
    """Only a complete, consistent append-only process journal can pass."""
    names = {"start.json", "receipt.json"} | {f"case-{i}.json" for i in range(1, 8)}
    require(root.is_dir() and {p.name for p in root.iterdir()} == names,
            "process evidence inventory incomplete or contains failure")
    start = read(root / "start.json")
    fields(start, ("schema", "repeat", "process_id", "process_nonce"), "process start")
    integer(start["schema"], 1, 1, "start schema")
    integer(start["repeat"], repeat, repeat, "start repeat")
    integer(start["process_id"], 1, 2**31 - 1, "start process id")
    text(start["process_nonce"], r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", "start nonce")
    for key in ("process_id", "process_nonce"):
        require(start[key] == record["metadata"][key], "start/process identity differs")
    receipt = read(root / "receipt.json")
    fields(receipt, ("schema", "repeat", "context", "metadata"), "process receipt")
    integer(receipt["schema"], 1, 1, "receipt schema")
    integer(receipt["repeat"], repeat, repeat, "receipt repeat")
    context(receipt["context"], runner, commit, c)
    metadata(receipt["metadata"], c)
    for key in ("context", "metadata"):
        require(receipt[key] == record[key], "journal receipt differs from final record")
    completed = []
    for index in range(1, 8):
        item = read(root / f"case-{index}.json")
        fields(item, ("schema", "repeat", "index", "case"), "completed case")
        integer(item["schema"], 1, 1, "case schema")
        integer(item["repeat"], repeat, repeat, "case repeat")
        integer(item["index"], index, index, "case index")
        completed.append(item["case"])
    cases(completed, expected, control)
    require(completed == record["cases"], "completed case evidence differs from final record")


def host(root, runner, commit, c):
    require(runner in RUNNERS, "unknown requested runner")
    root = Path(root)
    required = {"context.json", "record-1.json", "record-2.json", "process-1", "process-2"}
    names = {p.name for p in root.iterdir()}
    require(required <= names <= required | {"host-verdict.json"}, "host artifact inventory")
    ctx = read(root / "context.json")
    context(ctx, runner, commit, c)
    exp, control = expectations()
    records = []
    cpus = []
    for repeat in (1, 2):
        record = read(root / f"record-{repeat}.json")
        fields(record, ("schema", "repeat", "context", "metadata", "cases"), "record")
        integer(record["schema"], 1, 1, "record schema")
        integer(record["repeat"], repeat, repeat, "repeat identity")
        context(record["context"], runner, commit, c)
        require(record["context"] == ctx, "process context differs from prepared receipt")
        cpus.append(metadata(record["metadata"], c))
        checked_cases = cases(record["cases"], exp, control)
        journal(root / f"process-{repeat}", repeat, record, runner, commit, c, exp, control)
        records.append((record, checked_cases))
    first, second = records
    require(cpus[0] == cpus[1], "CPU changed between processes")
    for field in ("process_id", "process_nonce"):
        require(first[0]["metadata"][field] != second[0]["metadata"][field], f"fresh processes required: {field}")
    require(first[1] == second[1], "literal repeat bits/warnings disagree (including signed zero and NaNs)")
    return {"context": ctx, "cpu": cpus[0], "cases": first[1]}


def decide(root, commit):
    c = contract(commit)
    root = Path(root)
    require({p.name for p in root.iterdir()} == set(RUNNERS), "exactly two requested host artifacts required")
    hosts = [host(root / runner, runner, commit, c) for runner in RUNNERS]
    require({h["cpu"][0] for h in hosts} == {"AuthenticAMD", "GenuineIntel"}, "UNDECIDED STOP: actual CPUs do not provide AMD+Intel; no retry")
    for field in ("run_id", "workflow_ref"):
        require(hosts[0]["context"][field] == hosts[1]["context"][field], "hosts must belong to one paired dispatch")
    # Warnings can be platform prose. Arrays, identities and their ordering cannot.
    for ident in hosts[0]["cases"]:
        for name in ("points", "shape", "hull", "estimate"):
            require(hosts[0]["cases"][ident][name] == hosts[1]["cases"][ident][name], f"cross-host disagreement: {ident}/{name}")
    predictions = read(HERE / "predictions.json")["cases"]
    survivors = []
    for model in MODELS:
        good = True
        for p in predictions:
            if p["id"].startswith("seen-"):
                continue
            actual = hosts[0]["cases"][p["id"]]
            good &= actual["hull"] == matrix(p[model]["hull_bits"])
            good &= actual["estimate"] == matrix([p[model]["estimate_bits"]])
        if good:
            survivors.append(model)
    require(len(survivors) == 1, "UNDECIDED STOP: no unique model matches all six new cases")
    return {"round": ROUND, "status": "diagnostic-supported", "model": survivors[0], "production_approval": False, "hosts": [h["cpu"] for h in hosts], "commit": commit}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("host", "pair"))
    parser.add_argument("root", type=Path)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--runner", choices=RUNNERS)
    args = parser.parse_args()
    try:
        text(args.commit, COMMIT.pattern, "expected commit")
        if args.mode == "host":
            require(args.runner is not None, "host mode requires --runner")
            result = host(args.root, args.runner, args.commit, contract(args.commit))
            result = {"status": "host-valid-pair-undecided", "cpu": result["cpu"], "production_approval": False}
        else:
            require(args.runner is None, "pair mode has no --runner")
            result = decide(args.root, args.commit)
        print(json.dumps(result, sort_keys=True))
    except (Invalid, OSError, ValueError, KeyError, TypeError) as error:
        print(json.dumps({"status": "undecided-stop", "reason": str(error), "production_approval": False}))
        raise SystemExit(1)


if __name__ == "__main__":
    main()
