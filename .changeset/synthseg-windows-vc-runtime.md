---
"synthseg": patch
"@neurodesk/synthseg": patch
---

The Windows command-line archive now carries the Microsoft Visual C++ runtime next to ONNX Runtime. Without it, `synthseg.exe` failed on Windows machines that lack the Visual C++ Redistributable ("The specified module could not be found") or have a copy older than 14.40 ("A dynamic link library (DLL) initialization routine failed"), such as MRI scanner hosts. Every Windows portable archive is now also checked in clean Windows Server Core containers before release.

Release signing preserves valid vendor signatures and verifies every native binary. Clean Windows checks use digest-pinned images and a checksummed Microsoft installer.

Native SynthSR builds pin Rust 1.99.1, including local builds and browser-reference provisioning, until their ONNX Runtime build dependency supports Cargo 1.100's directory layout. SynthSeg's static native runtime is unaffected and continues to use stable Rust.
