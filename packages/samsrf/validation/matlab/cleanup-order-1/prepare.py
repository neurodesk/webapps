"""Prepare an exact-head receipt for one explicitly selected cleanup-order-1 job."""
import argparse
import json
import os
import subprocess
from pathlib import Path

from evaluate import COMMIT, ENVIRONMENT, HERE, ROUND, RUNNERS, context, contract, read, require, sha, text

INPUTS = {"sign_release", "record_matlab", "include_matrix", "diagnostics_only", "geometry_only", "geometry_probe", "geometry_causal", "geometry_reproducers", "geometry_hull_area", "revcor_only", "revcor_edges", "wasm_only", "qr_only", "qr_kernels", "numerics_only", "css_pipelines_only", "kernels_only", "gemv_order", "focused_probes", "arithmetic_order", "fitted_hrf", "probes", "controls_only", "runtime_cli", "runtime_image"}


def make_context(env, event, runner, c):
    require(env.get("GITHUB_EVENT_NAME") == "workflow_dispatch", "dispatch only")
    require(env.get("GITHUB_RUN_ATTEMPT") == "1", "no reruns under this budget")
    require(runner in RUNNERS, "preselected runner label required")
    selected = event.get("inputs")
    require(type(selected) is dict and set(selected) <= INPUTS, "unexpected workflow input")
    require(type(selected.get("record_matlab")) in (str, bool) and selected["record_matlab"] in ("true", True), "record_matlab must be selected")
    require(selected.get("probes") == ROUND, "wrong probe round")
    for name, value in selected.items():
        if name in ("record_matlab", "probes"):
            continue
        require(type(value) in (str, bool), f"workflow input type: {name}")
        allowed = ("none", "") if name == "runtime_cli" else ("",) if name == "runtime_image" else ("false", False, "")
        require(value in allowed, f"incompatible workflow input: {name}")
    require({key: env.get(key) for key in ENVIRONMENT} == ENVIRONMENT, "requested numerical environment differs")
    text(env.get("GITHUB_SHA"), COMMIT.pattern, "GITHUB_SHA")
    text(env.get("GITHUB_RUN_ID"), r"[1-9][0-9]*", "GITHUB_RUN_ID")
    require(env.get("GITHUB_REPOSITORY") == "neurodesk/webapps", "wrong repository")
    receipt = {"schema": 1, "round": ROUND, "base_commit": c["base_commit"], "commit": env["GITHUB_SHA"], "runner": runner,
            "repository": env["GITHUB_REPOSITORY"], "workflow_ref": env["GITHUB_WORKFLOW_REF"], "run_id": env["GITHUB_RUN_ID"],
            "run_attempt": 1, "contract_sha256": sha(HERE / "contract.json"), "source_files": c["files"],
            "input_sha256": sha(HERE / "inputs.tsv"), "requested_environment": ENVIRONMENT}
    context(receipt, runner, env["GITHUB_SHA"], c)
    return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    parser.add_argument("--runner", required=True, choices=RUNNERS)
    args = parser.parse_args()
    c = contract(os.environ.get("GITHUB_SHA"))
    ctx = make_context(os.environ, read(os.environ["GITHUB_EVENT_PATH"]), args.runner, c)
    root = HERE.parents[4]
    head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip()
    require(head == ctx["commit"], "checkout must equal the dispatch SHA")
    subprocess.run(["git", "merge-base", "--is-ancestor", c["base_commit"], "HEAD"], cwd=root, check=True)
    args.output.mkdir(parents=True, exist_ok=False)
    (args.output / "context.json").write_text(json.dumps(ctx, indent=2) + "\n", encoding="utf-8")
    print("Prepared exact-head receipt; two fresh MATLAB processes still required; no pair decision.")


if __name__ == "__main__":
    main()
