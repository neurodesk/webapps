# NeuroFlow validator (vendored)

`neuroflow_wasm.js` and `neuroflow_wasm_bg.wasm` are the `wasm-pack --target web` build of
`crates/neuroflow-wasm` from [NeuroFlow](https://github.com/cdrake/neuroflow), unmodified.
The builder uses `validate_workflow_with_tools_json` so a workflow is checked by the same core
rules `neuroflow-mcp` runs, rather than a copy of them in this app.

`provenance.json` names the commit and the SHA-256 of each file; `test/vendor.test.js` checks the
hashes. To update, run `npm run wasm:build` at the release tag in a NeuroFlow checkout, copy the
three files from its `src/wasm` here and update `provenance.json`. The build remaps host paths, so
the same rustc, wasm-bindgen and wasm-opt give the same bytes; `build` records that toolchain.

NeuroFlow is dual-licensed under MIT or Apache-2.0; `LICENSE-MIT` is included.
