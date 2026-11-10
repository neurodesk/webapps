---
"@neurodesk/webapp-components": patch
"calcium-imaging": patch
"stitching": patch
---

Move the complex FFT (radix-2 with Bluestein for other lengths, in any number of dimensions) to `@neurodesk/webapp-components/fft` and use it from calcium imaging and stitching, replacing their two app copies. Results are unchanged.
