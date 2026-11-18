---
"samsrf": patch
---

SamSrf draws its maps on FreeSurfer surfaces that end at their faces, as MATLAB's `write_surf` writes them. NiiVue 1.0.0-rc.26 could not read such a surface: it logged the error, the app showed "Ready", and every run then ended with "Cannot read properties of undefined (reading 'layers')" after offering its maps. The viewer now reads every surface with the engine's own reader and draws it from mz3, so it shows the mesh the analysis reads, and a surface that cannot be shown is reported in the status bar. A surface still loading when Clear inputs or another surface replaces it no longer changes the viewer: before, the replaced surface could stay on screen, and the next run could end with the same error after offering its maps.

A model whose `Hrf` names a subject's HRF fit (`hrf_*.mat`) now runs in the app. The app takes the file in a Subject HRF field or from a dropped folder and gives the engine SamSrf's old-school kernel built from the file's `fP`. A file not named `hrf_*.mat` is refused, a malformed one stops the run with its name, and vertex-wise HRF maps are still refused.

The CSS convention help now says that downloaded maps keep the real parts of SamSrf's complex results, as SamSrf's GIfTI export does.
