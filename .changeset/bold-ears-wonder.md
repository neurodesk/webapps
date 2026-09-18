---
---

Fix the composite runtime inventory test to compare each app with its own standalone ONNX Runtime files instead of requiring MuscleMap's loaders everywhere. Verify retained files against pinned checksums and fail when a required app-scoped runtime directory is missing.
