---
"@neurodesk/hmc-registration": patch
---

Link dlmalloc instead of the ITK-Wasm toolchain's mimalloc. Registrations write the same bytes (the HMC Q53 replay and the 1.2 mm SyN-SDC replay of #462 included), and the 1.2 mm SyN registration now peaks at 2.16 GB of WebAssembly memory instead of the 4 GiB maximum.
