---
"@neurodesk/samsrf": patch
"samsrf": patch
---

Follow MATLAB R2023b's real `x'*y` at every length: adjacent products summed in pairs below 51 elements and MKL's `ddot` from 51. Double CSS fits on fewer than 51 volumes could differ from MATLAB in the last bit; all 1,200 recorded `corr` objectives at 25-250 elements now equal MATLAB's on the AMD reference host (223 differed before). MKL's Intel AVX-512 branch remains a documented host difference.
