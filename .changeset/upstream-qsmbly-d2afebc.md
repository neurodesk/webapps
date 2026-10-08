---
"qsmbly": patch
---

Merge upstream astewartau/qsmbly 2f91e83..d2afebc:

- Add a bench for what the DL thread pool costs in wasm heap (#119)
- Deploy the staging branch to qsmbly.neurodesk.org/staging (#121)
- Create CNAME
- Accept a v-prefixed version on the manual deploy, and check it before building (#123)
- Write .nojekyll when publishing, so Pages serves the branch as-is (#124)
- Let staging deploys supersede each other, and make overlapping ones safe (#125)
- Record the #89 pool-size sweep on stable hardware, and let run_bench.sh pick its browser (#122)
- Surface errors on mask paths that failed silently or crashed (#126)
- Tidy the build, dev-server and dependency-bump scripts (#127)
- Consolidate CSS: move inline style block, define missing variables, remove dead and duplicate rules (#136)
- Clean up the worker layer: report errors once, drop dead code, honour TGV settings (#135)
- Validate WASM export inputs, reject unknown enum codes, tidy lint and logging (#134)
- Accessibility, pinned CDN assets with SRI, privacy and README docs, smaller icons (#133)
- Escape file-derived text, delete dead app/controller code, fix UI robustness issues (#132)
- Derive V-SHARP and iLSQR defaults from the generated qsm-defaults.js (#131)
- CI: build what deploy builds, add linting, deploy the release tag (#129)
- Make worker init fail loudly, survive Cancel, and drop dead stage skipping (#128)
- Decode .nii.gz properly, apply field-map voxel defaults, lazy-load dicompare (#130)
- Test ConfigBridge against qsmxt-config and cover the near-pure controllers (#138)
- Keep deep-learning tile patches small enough to run in the browser at all (#137)
- Modal focus management, single <h1>, Tagify without !important, hidden-attribute panels (#139)
- Restructure the WASM bindings: shared helpers, one error convention, one DL tiling table (#141)
- Make MaskController own mask state, drop unused executor surface, send typed arrays to the worker (#140)
- One numerical path: run field-map modes and QSMART through the config-driven qsm-core stages (#142)
