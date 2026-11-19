---
"@neurodesk/samsrf": minor
"samsrf": minor
---

The `samsrf` command line takes a subject's HRF fit with `--hrf hrf_*.mat` for `prf` and `rc`. The model's `Hrf` must name that file (`Hrf: "hrf_fit"` reads `hrf_fit.mat`). The kernel is the one the web app builds, `hrf.oldSchool(TR, fP)`, so the maps are the app's byte for byte. The command line refuses a fit not named `hrf_*.mat`, a model that names a fit without `--hrf`, a fit the model does not name, and `--hrf` with `cf`. A missing fit, a file that is not a MAT file and an `fP` that is missing or not four values stop the run before the runs are read. `readAnalysisInputs` reads the fit (`subjectHrf`), `analysisSpec` turns it into `spec.hrf` with the new `subjectHrfKernel`, and `@neurodesk/samsrf/inputs` holds the file-name rules (`isSubjectHrf`, `isSubjectHrfFile`, `subjectHrfName`), which the app now imports instead of keeping its own copies. Runs without a subject fit give the same files as before.

Automation takes the fit as the optional `subjectHrf` input of `prf` and `rc`, as the Subject HRF field does, and refuses a file not named `hrf_*.mat`.

On phones and in landscape, the viewer's info line and the collapsed log no longer run past the viewer into the status bar. The site theme's minimum canvas height now applies only to the legacy shells, because the shared workspace's grid already sizes the viewer. At 390 × 844 the info line had ended 13 px below the top of the status bar and the log was hidden.
