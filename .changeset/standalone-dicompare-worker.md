---
"@neurodesk/desktop": patch
---

Build the bundle's dicompare worker from this repository instead of downloading it from dicompare.neurodesk.org, whose redeploys failed the nightly build, and fix SeedSeg's offline asset list, which still named NiiVue 0.44.0. Offline asset verification now fails when an app's locked asset list differs from its sources.
