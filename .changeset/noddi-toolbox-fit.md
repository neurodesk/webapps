---
"noddi": minor
"@neurodesk/noddi": minor
---

Offer the NODDI toolbox 1.05 fit as a third NODDI method beside the default AMICO and the nonlinear dmipy fit: a Rust and WebAssembly port (`exes/dwi/noddi-toolbox`, Artistic License 2.0) of the toolbox's in-vivo Watson model, its grid search and its two-stage Rician maximum-likelihood fit, with its own erfi-independent special functions. Select it in the app's NODDI fit menu, with automation `method: "toolbox"` or with `noddi --method toolbox`; provenance records the toolbox source and voxel diagnostics. On the pinned white-matter gate (13,327 voxels) its maps are within a median absolute difference of 3.3e-6 (ICVF), 3.4e-6 (ISOVF) and 3.9e-7 (ODI) of the toolbox's. About, Cite and the package notices name the toolbox and its paper.
