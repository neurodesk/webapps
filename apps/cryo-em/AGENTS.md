# cryo-em instructions

- The app only builds and follows RELION jobs; RELION runs on the user's cluster through a single-owner `neurodesk-compute` ([ADR-0004](../../docs/adr/0004-hpc-batch-compute-for-cryo-em.md)). Step forms are generated from `packages/cryo-em/src/commands.json` and checked with its `validateRelionSpec` before submitting; the app adds only words (`src/steps.js`). A new option or command needs no app change beyond its label.
- The example's movies live on the server (`neurodesk-compute fetch-example relion-tutorial` fills the `examples` data root); `examples.json` pins only the tutorial's `SHA256SUMS`, which the app checks against the root's listing before filling the tutorial settings (`src/example.js`).
- NiiVue cannot read MRC, so `src/mrc.js` reads it and maps go to NiiVue as display-only NIfTI; image stacks are drawn as `<img>` grids because the shared stylesheet stretches every canvas inside the viewer.
- `e2e/compute-server.mjs` (browser tests) and the desktop workflow run the Node reference server (simulated relion tool) on `e2e/fixtures.mjs`'s placeholder tutorial; keep its `NUMBERS` equal to the tutorial's SHA256SUMS.
