---
"sdc": minor
"@neurodesk/webapp-components": minor
---

SDC adds SyN-SDC to its method selector: sdcflows 2.17.1's fieldmap-less correction from one DWI series and a T1w (`@neurodesk/sdc/syn`), run in a worker in the browser. MindGrab masks the mean b0 and the T1w on its CPU modules unless masks are uploaded. The sidebar asks for the phase-encoding direction and the total readout time only when no sidecar has them, and a run without them is refused. The app writes the corrected DWI series with its bval, bvec and sidecar, the field map in Hz, its B-spline coefficients, the displacement field and the brain mask, shows the field over the corrected mean b0, and logs per-stage times and field QC in the console. The new example is the ds005134 slab with the full T1w; its outputs equal the Node pipeline's byte for byte. `createNiivueVolumePreview` draws an optional signed overlay on its image and clears the viewer when given `null`.
