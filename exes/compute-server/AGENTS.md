# NeSVoR and the compute server instructions

- `apps/nesvor` is the first app whose method runs outside the browser: NeSVoR needs CUDA, so the
  app sends jobs to a `neurodesk-compute` server the user runs in their own network
  ([ADR-0003](../../docs/adr/0003-remote-compute-nodes.md), [design](../../docs/architecture/nesvor-remote-compute.md),
  [protocol](../../docs/architecture/remote-compute-protocol.md)). The connection panel is the shared
  `nd-compute-connection` element and the client is `@neurodesk/webapp-components/compute`; do not
  write app-local fetch code for the protocol.
- `exes/compute-server` (Rust, binary `neurodesk-compute`) and `test-utils/compute-reference-server.mjs`
  (Node, simulated tool, used by browser and desktop tests) implement protocol v1. Change the protocol
  document first, then both implementations, then run `test/remote-compute-protocol.test.mjs` against
  both (`COMPUTE_SERVER_URL`/`COMPUTE_SERVER_TOKEN` select a running server). `apps/nesvor/src/spec.js`
  is shared by the app and the reference server; `exes/compute-server/src/tools/nesvor.rs` mirrors it.
- The container digest is pinned in the design document, `registry/neurocontainers.json`, the Rust tool
  definition and the reference server. Update all four together. The SCT tool's image is pinned in
  `apps/spinalcordtoolbox/web/js/app/analysis-spec.js`, `exes/compute-server/src/tools/sct.rs`,
  `registry/neurocontainers.json`, the protocol document and both READMEs;
  `apps/spinalcordtoolbox/test/native-analysis.test.js` fails when they disagree.
- An app whose processing is not in the browser overrides `execution` in `registry/app-information.yml`
  and states the data flow in its own Privacy template. The desktop suite reaches a compute server only
  through `NEURODESK_COMPUTE_ORIGINS`.
