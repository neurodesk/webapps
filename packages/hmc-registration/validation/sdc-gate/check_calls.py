"""Check the complete call inventory and kernel provenance of e2e.sh or replay.sh.

    python -I check_calls.py RUN WASM_SHA256 [--mode e2e|replay]

The default is e2e: ten kernel calls and one native DenoiseImage call. A SyN-only
replay has six kernel calls. Both logs must contain each expected workflow node
exactly once, with matching full working directories and successful exits.
"""

import argparse
import json
from collections import Counter
from pathlib import Path

REPLAY_NODES = {
    "syn_sdc_wf/lap_anat": "ImageMath",
    "syn_sdc_wf/lap_epi": "ImageMath",
    "syn_sdc_wf/amask2epi": "antsApplyTransforms",
    "syn_sdc_wf/syn": "antsRegistration",
    "syn_sdc_wf/zooms_field": "antsApplyTransforms",
    "syn_sdc_wf/zooms_bmask": "antsApplyTransforms",
}
E2E_NODES = {
    **REPLAY_NODES,
    "syn_preprocessing_wf/ref_anat": "DenoiseImage",
    "syn_preprocessing_wf/epi2anat": "antsRegistration",
    "syn_preprocessing_wf/anat2epi": "antsApplyTransforms",
    "syn_preprocessing_wf/mask2epi": "antsApplyTransforms",
    "syn_preprocessing_wf/prior2epi": "antsApplyTransforms",
}


def records(path):
    with path.open() as stream:
        return [json.loads(line) for line in stream if line.strip()]


def check_calls(run, wasm_sha256, mode):
    run = Path(run).resolve()
    workflow = run / "work" / "sdc_ref"
    expected = E2E_NODES if mode == "e2e" else REPLAY_NODES
    timed = [c for c in records(run / "ants-calls.jsonl") if c["argv"] != ["--version"]]
    kernel = records(run / "wasm-calls.jsonl")
    calls, problems = [], []

    def identity(call, program_key):
        return call[program_key], str(Path(call["cwd"]).resolve())

    inventory = Counter(identity(c, "tool") for c in timed)
    required = Counter((tool, str(workflow / node)) for node, tool in expected.items())
    for key, count in (required - inventory).items():
        problems.append(f"missing {count} call(s): {key}")
    for key, count in (inventory - required).items():
        problems.append(f"unexpected or duplicate {count} call(s): {key}")

    wrapped = []
    for c in timed:
        in_kernel = "ants-cli.mjs" in c["command"]
        cwd = Path(c["cwd"]).resolve()
        node = str(cwd.relative_to(workflow)) if cwd.is_relative_to(workflow) else str(cwd)
        calls.append({
            "tool": c["tool"], "node": node,
            "where": "wasm" if in_kernel else "native", "exit": c["exit"],
            "wall_s": c["wall_s"], "max_rss_kb": c["max_rss_kb"],
        })
        if c["exit"] != 0:
            problems.append(f"{c['tool']} in {node} exited {c['exit']}")
        if (c["tool"] == "DenoiseImage") == in_kernel:
            problems.append(f"{c['tool']} in {node} ran {'in the kernel' if in_kernel else 'natively'}")
        if in_kernel:
            wrapped.append(identity(c, "tool"))
    for k in kernel:
        if k["wasm_sha256"] != wasm_sha256:
            problems.append(f"{k['program']} in {k['cwd']} ran kernel {k['wasm_sha256']}")
        if k.get("exit") != 0 or k.get("error") is not None:
            problems.append(f"{k['program']} in {k['cwd']} failed: exit={k.get('exit')}, error={k.get('error')}")
        if not k.get("argv"):
            problems.append(f"{k['program']} in {k['cwd']} has no recorded argv")
    if Counter(wrapped) != Counter(identity(k, "program") for k in kernel):
        problems.append("wrapper and kernel records do not match one to one by program and full working directory")
    return {
        "mode": mode, "calls": calls,
        "kernel_programs": sorted({k["program"] for k in kernel}),
        "native_programs": sorted({c["tool"] for c in calls if c["where"] == "native"}),
        "largest_wasm_heap_bytes": max((k["wasm_heap_bytes"] for k in kernel), default=None),
        "problems": problems,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("run")
    parser.add_argument("wasm_sha256")
    parser.add_argument("--mode", choices=["e2e", "replay"], default="e2e")
    args = parser.parse_args()
    result = check_calls(args.run, args.wasm_sha256, args.mode)
    print(json.dumps(result, indent=1))
    raise SystemExit(1 if result["problems"] else 0)
