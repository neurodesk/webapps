---
"@neurodesk/samsrf": minor
---

Phase 1 of the SamSrf port: a Rust core compiled to one WebAssembly binary for browsers and Node, with GIFTI, FreeSurfer, MAT v5, NIfTI and GIF readers, the SPM-style GIFTI map writer, aperture vectorisation, model JSON parsing with `samsrf_model_defaults`, the model expression language and pRF profile functions, every HRF variant, `samsrf_gii2srf` preprocessing with the noise ceiling and global signal, and `samsrf_removenoise`. The analyses (`samsrf_fit_prf`, `samsrf_revcor_prf`, `samsrf_revcor_cf`) are declared and arrive in phase 2. An Octave harness runs SamSrf's own sources for the reference; 106 parity checks pass at 1e-9.
