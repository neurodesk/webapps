---
"greedy": minor
"@neurodesk/greedy": minor
---

greedy-rs registers with Greedy's neighbourhood cross-correlation for stationary-velocity warps: `-m NCC 2x2x2` (any radius) on the command line, `register_svf_masked_wasm` with metric `NCC 2x2x2` in WebAssembly and `registerSvfGreedy` in JavaScript. Its gradient is the exact one of Greedy's unweighted NCC. On five T1-to-ICBM 2009c registrations it matched Greedy 1.4's correlation to within 0.004. Unlike Greedy, it adds no random noise to the images, so its results stay deterministic.
