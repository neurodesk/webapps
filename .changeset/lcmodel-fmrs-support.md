---
"lcmodel": minor
"@neurodesk/lcmodel": minor
"@neurodesk/webapp-components": patch
---

Add native functional MRS (fMRS) preprocessing, windowed LCModel fitting, and dynamic spectral projection GLM across FID-A, WASM, the `@neurodesk/lcmodel` library/CLI, and the LCModel web app.

- **FID-A / WASM preprocessing (`exes/fida`, `packages/lcmodel/wasm`):** Preserve individual transients with true acquisition indices and timestamps through coil combination, multi-pass bad-average removal, drift correction, consistent grand-mean phasing, optional BOLD T2* linewidth matching, and LCModel `.COORD`-aligned complex transient spectra. Add TWIX `_onlyrfoff` / `_rfoff` water detection and affirmative water-reference sharing.
- **fMRS statistical analysis & reporting (`@neurodesk/lcmodel`):** Parse BIDS `events.tsv` / CSV stimulus schedules; build sliding-window, event-block, and condition-pooled bins; classify per-window QC; fit continuous-time AR(1) (`CAR(1)`) REML windowed contrasts and linear time trends with complete-case linewidth control and zero-variance suppression; fit two-stage fixed-template dynamic spectral projection GLMs with complex alignment RMS gating, per-component VIF rank guards, and Newey-West HAC standard errors; export time-course CSVs, condition contrasts CSV, SVG figures, and printable HTML reports; expose CLI `--fmrs-*` flags, empirical macromolecule (`nsimul=0`), and baseline stiffness (`dkntmn`).
- **LCModel web app, basis library & automation (`apps/lcmodel`, `models/lcmodel.manifest.json`):** Add the simulated 7 T STEAM TE 6 ms basis set (`steam-7t-te6`) with exact-TE recommendation tie-breaking, Functional MRS controls, interactive Time course views (metabolite trajectories, QC, per-transient drift even when every window fit fails, and condition/dynamic stats with clickable window inspection), grand-mean and per-window downloads, and the `fit-fmrs` WebMCP/automation operation.
- **Page drop & Undo (`@neurodesk/webapp-components`):** Route `.tsv`/`.csv` files to compatible `metadata` inputs and preserve opted-in auxiliary inputs (`restoreWithUndo: true`) on the active Undo snapshot, including synchronously before async replacement reads/renders finish.
