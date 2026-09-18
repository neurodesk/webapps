---
---

Fix the composite runtime inventory test to compare each app with its own standalone ONNX Runtime files instead of requiring MuscleMap's loaders everywhere. Verify retained files against pinned checksums and fail when a required app-scoped runtime directory is missing.

Run the brain-extraction production build before starting Playwright so cold Rust/WASM compilation does not consume the preview-server startup timeout.
