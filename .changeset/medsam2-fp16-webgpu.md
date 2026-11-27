---
"medsam2": patch
---

Pack large ONNX weight initializers in FP16 with FP32 runtime unpacking (`Cast(f16 → f32)` folded once at session init) across all four MedSAM2 models, cutting total download and offline bundle size in half (168.0 MB → 84.3 MB; 2D cold start 135.1 MB → 67.8 MB) for both WebGPU and WebAssembly while preserving full FP32 PyTorch parity.
