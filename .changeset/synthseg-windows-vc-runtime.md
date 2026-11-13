---
"synthseg": patch
"@neurodesk/synthseg": patch
---

The Windows command-line archive now carries the Microsoft Visual C++ runtime next to ONNX Runtime. Without it, `synthseg.exe` failed on Windows machines that lack the Visual C++ Redistributable ("The specified module could not be found") or have a copy older than 14.40 ("A dynamic link library (DLL) initialization routine failed"), such as MRI scanner hosts. Every Windows portable archive is now also checked in clean Windows Server Core containers before release.
