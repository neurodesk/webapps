---
"@neurodesk/samsrf": patch
"samsrf": patch
---

Follow MATLAB R2023b's sparse `conv` (fewer than a quarter of the samples nonzero, kernels of 9 taps or more) in which products it rounds before adding: every product for kernels of at most 16 taps, and products near 8 KiB block boundaries when the convolution is longer than 16 KiB. Two pre-registered MATLAB recordings found the rule on discovery courses and confirmed it on held-out ones (12 courses with 13-300 taps, complex and real, every kept output part); the previous port fused every product and missed up to 15,219 parts per course. HRF kernels of 9-16 taps (for a 32 s HRF, repetition times of about 2.1-4 s) change sparse predictions at every length; longer kernels only on convolutions longer than 1,024 complex or 2,048 real samples. Kernels of fewer than 9 taps and dense predictions are unchanged. The public single RC 2D and CF Gaussian refusals are unchanged.
