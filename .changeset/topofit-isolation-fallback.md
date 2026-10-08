---
"topofit": patch
---

Make the deployed app cross-origin isolated through the shared service-worker fallback, as the other threaded apps are. GitHub Pages cannot send isolation headers, so TopoFit had always run ONNX Runtime on one thread there; it now gets the two-thread speedup. The processing manifest reports one thread when a browser cannot isolate the page.
