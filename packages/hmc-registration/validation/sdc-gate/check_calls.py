"""Where each ANTs call of an e2e.sh or replay.sh run ran (#462).

    python -I check_calls.py RUN WASM_SHA256

RUN/ants-calls.jsonl (timed.sh) lists every call that nipype made; RUN/wasm-calls.jsonl
(ants-cli.mjs) lists the calls that ran in a kernel, with its SHA-256. The run passes when every
antsRegistration, antsApplyTransforms and ImageMath call ran in the kernel WASM_SHA256 and exited 0,
and DenoiseImage, which the kernel does not have, is the only native program. The kernel records
must match the calls through ants-cli.mjs one to one. It prints each call (node, where it ran,
exit status, wall time, max RSS) and exits 1 on any problem. A node that nipype took from its cache
makes no call; e2e.sh starts from an empty work directory, so every node of its run is listed.
"""

import json
import sys
from pathlib import Path


def records(path):
    return [json.loads(line) for line in path.open()]


def main(run, wasm_sha256):
    run = Path(run)
    timed = [c for c in records(run / "ants-calls.jsonl") if c["argv"] != ["--version"]]
    kernel = records(run / "wasm-calls.jsonl")
    calls, problems = [], []
    for c in timed:
        in_kernel = "ants-cli.mjs" in c["command"]
        node = Path(c["cwd"]).name
        calls.append(
            {
                "tool": c["tool"],
                "node": node,
                "where": "wasm" if in_kernel else "native",
                "exit": c["exit"],
                "wall_s": c["wall_s"],
                "max_rss_kb": c["max_rss_kb"],
            }
        )
        if c["exit"] != 0:
            problems.append(f"{c['tool']} in {node} exited {c['exit']}")
        if (c["tool"] == "DenoiseImage") == in_kernel:
            problems.append(f"{c['tool']} in {node} ran {'in the kernel' if in_kernel else 'natively'}")
    for k in kernel:
        if k["wasm_sha256"] != wasm_sha256:
            problems.append(f"{k['program']} in {Path(k['cwd']).name} ran kernel {k['wasm_sha256']}")
    in_kernel = [c for c in calls if c["where"] == "wasm"]
    if [(c["tool"], c["node"]) for c in in_kernel] != [(k["program"], Path(k["cwd"]).name) for k in kernel]:
        problems.append(f"{len(in_kernel)} calls through ants-cli.mjs, {len(kernel)} kernel records, not one to one")
    summary = {
        "calls": calls,
        "kernel_programs": sorted({k["program"] for k in kernel}),
        "native_programs": sorted({c["tool"] for c in calls if c["where"] == "native"}),
        "largest_wasm_heap_bytes": max((k["wasm_heap_bytes"] for k in kernel), default=None),
        "problems": problems,
    }
    print(json.dumps(summary, indent=1))
    if problems:
        sys.exit(1)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(*sys.argv[1:])
