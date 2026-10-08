---
"@neurodesk/desktop": patch
---

Pin every offline source to an immutable URL so a host redeploy can no longer fail the nightly checksum check. CALMAR assets move to fixed Hugging Face and GitHub commits, QSMbly loads Inter from versioned font files, and the unused QSMbly OSF multi-echo files and NiiVue demo images (NiiMath, SynthSR) leave the bundle. `test/offline-asset-pins.test.mjs` rejects unpinned sources.
