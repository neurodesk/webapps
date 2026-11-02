---
"samsrf": minor
"@neurodesk/webapp-components": patch
---

Add SamSrf, which maps population receptive fields and connective fields on the cortical surface from GIfTI time series: a forward-model pRF fit, reverse-correlation pRF and reverse-correlation connective fields, with SamSrf's model presets, its GIfTI map set and the maps drawn on the inflated surface with an R² threshold. Shared components gain `writeMz3Scalars`, a scalar-only mz3 that NiiVue loads as a mesh layer, and `readFreeSurferCurv`.
