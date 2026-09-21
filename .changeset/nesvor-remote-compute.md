---
"nesvor": minor
"@neurodesk/webapp-components": minor
"@neurodesk/desktop": minor
---

Add the NeSVoR fetal slice-to-volume reconstruction app and the decoupled compute feature it needs. The app prepares stacks, thicknesses and protocol presets in the browser and sends the job to a `neurodesk-compute` server in the user's own network (`exes/compute-server`, Rust), which runs the pinned Neurodesk `nesvor` 0.5.0 container and streams progress back. The components package gains the remote compute client (`@neurodesk/webapp-components/compute`) and the `nd-compute-connection` sidebar panel; the desktop suite admits the origins listed in `NEURODESK_COMPUTE_ORIGINS`. The shared About statement is split into `builder` and a per-app overridable `execution` sentence.
