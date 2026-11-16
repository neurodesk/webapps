---
"@neurodesk/samsrf": patch
"samsrf": patch
---

Detrend, z-score and average time courses as MATLAB R2023b does in `samsrf_gii2srf`. `detrend` now removes the line fitted by one `[linspace(0,1,n)' ones] \ Data` over every vertex of the run, rounded as MKL's `?ormqr` rounds each vertex by its place among them; `zscore` uses MATLAB's `mean` and `sum`; and averaged runs are summed in run order, as `nanmean(Data, 3)` does, even when the noise ceiling also needs the odd and even runs. The previous centred normal equations and odd-plus-even sum moved double courses by up to 1.2e-14. On the AMD host of the pinned SamSrfAnalysis recording, every double and single preprocessed course of the 22 runs whose saved `Srf.Y` is this stage's output now equals MATLAB's (168,000 of 168,000 values; 86,876 before), and the web app's maps equal MATLAB's in 93 of 168 maps (77 before). The Intel host's MKL rounds the double solve in another order and still differs. Averaging with the noise ceiling over every vertex of a hemisphere needs a third running sum (about 1 GB instead of 671 MB for 134,260 vertices and 250 volumes). The public single RC 2D and CF Gaussian refusals are unchanged.
