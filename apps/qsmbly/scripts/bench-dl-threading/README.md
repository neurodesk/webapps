# Deep-learning threading bench

Measures what the rayon pool size costs in **wasm heap** and in wall time for QSMbly's
deep-learning inversions, tiled or whole-volume. Built for
[astewartau/QSM.rs#89](https://github.com/astewartau/QSM.rs/issues/89), where threaded ONNX
inference helped whole-volume inference and did nothing for the tiled path.

The thing it measures that nothing else does: **every concurrent tile holds its own set of tract
activations in the one shared 32-bit heap**, so the pool size and the patch size together decide
how close a run gets to the 4 GB ceiling. Crossing that ceiling aborts the module.

## Running it

```bash
./build.sh                                   # threaded build, from the repo root
python3 scripts/bench-dl-threading/serve.py  # serves the repo root, isolated, on :8099
scripts/bench-dl-threading/run_bench.sh '[{"threads":14},{"threads":5}]'
```

Weights are fetched from HuggingFace on each run (cross-origin fetch works under the
`credentialless` COEP this server sends). To use a local copy instead, symlink it into the repo
and pass `weightsUrl`:

```bash
ln -s ~/.cache/qsm-rs/models/xqsm.onnx xqsm.onnx
scripts/bench-dl-threading/run_bench.sh '[{"threads":14,"weightsUrl":"/xqsm.onnx"}]'
```

Or open `http://localhost:8099/scripts/bench-dl-threading/index.html` and press the button.

`run_bench.sh` launches `google-chrome-stable`; set `CHROME` to use another binary, e.g. a
[Chrome for Testing](https://googlechromelabs.github.io/chrome-for-testing/) download on a host
with no system Chrome:

```bash
CHROME=~/.cache/chrome-for-testing/chrome/linux-155.0.8059.39/chrome-linux64/chrome \
  scripts/bench-dl-threading/run_bench.sh '[{"threads":14}]'
```

**Firefox cannot run this.** It hangs in `initThreadPool` inside a nested module worker, which is
exactly how QSMbly's pipeline worker calls it. Use Chrome.

## Plan fields

A plan is a JSON array of overrides on `DEFAULTS` in `index.html`:

| field | default | meaning |
|---|---|---|
| `mode` | `tiled` | `tiled` or `whole` |
| `model` | `xqsm` | any model id `run_dl_field_inversion_wasm` accepts |
| `nx`,`ny`,`nz` | 128,128,96 | synthetic volume size |
| `core`, `halo` | 56, 4 | tile config; `core + 2*halo` is the patch edge |
| `threads` | `hardwareConcurrency` | rayon pool size; `0` starts no pool |
| `flag` | `false` | `set_threads_ready_wasm`, i.e. tract's own threading |
| `reps` | 3 | repeats per configuration |
| `weightsUrl` | HuggingFace | override the weights source |
| `timeoutS` | 1800 | give up on one configuration |

One worker per configuration, because `initThreadPool` is once per module instance. That also
means each configuration reports a heap high-water attributable to it alone.

## Reading the output

```
[tiled] xqsm 128x128x96 core=56 halo=4 pool=14 threads_ready=false
    rep0: 114.9s  heap=2827MB  sum=-7.605027  waves=[82.5, 31.4]s
```

* `heap` is `out.memory.buffer.byteLength`. wasm memory only grows, so this is the peak.
* `sum` is a sparse checksum. It must not change between configurations; threading is supposed to
  be bit-identical.
* `waves` are the gaps between progress callbacks. The driver batches tiles to bound memory, so
  each gap is one wave of concurrent tiles.

Reference figures from #89 (Chromium, 14 hardware threads, 128x128x96, xQSM):

| tile config | pool | heap high-water |
|---|---|---|
| core 56, halo 4 (64³ patches) | 4 | 1.10 GB |
| core 56, halo 4 (64³ patches) | 14 | 2.6-2.8 GB |
| core 96, halo 4 (104³ patches) | 4 | 3.71 GB |

1.10 GB is 4 x 269.5 MB of activations plus an 11 MB base. `qsm-core`'s
`inversion::tile_concurrency` now caps the concurrent-tile count on wasm so the last row cannot
happen; the heap figures here are how to check that it holds for a given model and patch size.

## ctl.c: read this before trusting a timing

`ctl.c` is a fixed-cost single-threaded loop. Its run-to-run spread is the machine's timing noise
floor:

```bash
cc -O1 -o /tmp/ctl scripts/bench-dl-threading/ctl.c
for i in $(seq 8); do /tmp/ctl; done
```

On the laptop used for #89 it ranged 1.03 s to 11.18 s, with cores clamped at 400 MHz of 4800
while the package was 90% busy. That is larger than the 1.8x slowdown the issue set out to
explain. **If this spread is comparable to the effect you are chasing, the effect is not
measured.** Heap figures are unaffected by load.

On a machine where it holds still, the sweep is decisive:
[`results/2026-10-07-neurodesk-epyc.md`](results/2026-10-07-neurodesk-epyc.md) has a 1.3% floor
over 8 runs, and the pool-size differences it resolves range from 20% to 670%.

Note `ctl.c` exits **1** on a successful run (`return (int)(s > 0)`, which also stops the loop
being optimized away). A `set -e` harness has to tolerate that status.

## results/

Completed sweeps, one file per machine and date, each recording the exact commands, the bundle
commit, the qsm-core revision, the Chrome and rustc versions, every repetition, and the noise
floor measured in the same window.
