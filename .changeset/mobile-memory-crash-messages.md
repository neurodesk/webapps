---
"@neurodesk/webapp-components": patch
"@neurodesk/runtime-support": patch
"qsmbly": patch
"synthseg": patch
"dicompare": patch
---

Show clear, phone-sized status-bar and technical-log guidance when a webapp hits browser or graphics memory limits, when a processing worker terminates unexpectedly mid-run, or when a mobile browser kills and reloads an active tab without firing `pagehide`. Route updates through the shared `ProgressManager`, `ConsoleOutput`, and React status owners without disturbing active cancellation controls, discard failed worker sessions so retries start fresh, preserve `GPUOutOfMemoryError` identity across empty-message WebGPU error scopes, and include `navigator.deviceMemory` in Support issue templates.
