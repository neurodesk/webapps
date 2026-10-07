---
"@neurodesk/synthseg": patch
---

Pin the SHA-256 of every validation input and FreeSurfer golden in `model.manifest.json` (`validation.sha256`). `make -C exes/synthseg fetch-validation` now verifies cached and freshly downloaded copies against them, so the native and browser parity checks never compare against an unchecked file.
