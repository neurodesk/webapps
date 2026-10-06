# Independent check of LCModel's water-scaled concentrations with spant's ABfit
# (Martin Wilson, CRAN `spant`), on the same .RAW/.H2O the app hands LCModel.
# Scaling is spant's scale_amp_legacy: WCONC 35880 x ATTH2O 0.7 over the water's
# time-domain amplitude at t = 0 -- LCModel's convention, no relaxation or tissue
# correction -- so the numbers compare directly with LCModel's defaults.
#
#   Rscript spant_water_scaled.R <spectrum.raw> <water.h2o> <ft Hz> <basis> [TE1 s] [TE2 s]
#
# <basis> is "spant" for spant's simulated PRESS basis (with MM and lipids) or an
# LCModel .BASIS file. spant reads a .BASIS at LCModel's FFT scale, so an FID-A
# basis (1 per proton at t = 0) gives amplitudes 0.5 * sqrt(NDATAB) too large;
# the script divides them out (45.25 for NDATAB 8192).
suppressMessages(library(spant))
args <- commandArgs(trailingOnly = TRUE)
raw <- args[1]
h2o <- args[2]
ft <- as.numeric(args[3])
basis_arg <- args[4]
te1 <- if (length(args) > 4) as.numeric(args[5]) else 0.01
te2 <- if (length(args) > 5) as.numeric(args[6]) else 0.02
metab <- read_mrs(raw, format = "lcm_raw", ft = ft, fs = 2000, ref = 4.65)
wref <- read_mrs(h2o, format = "lcm_raw", ft = ft, fs = 2000, ref = 4.65)
scale <- 1
if (basis_arg == "spant") {
  basis <- sim_basis_1h_brain_press(metab, TE1 = te1, TE2 = te2)
} else {
  ndatab <- as.numeric(sub(".*NDATAB\\s*=\\s*([0-9]+).*", "\\1", paste(readLines(basis_arg, n = 40), collapse = " ")))
  basis <- resample_basis(read_basis(basis_arg, ref = 4.65), metab)
  scale <- 1 / (0.5 * sqrt(ndatab))
}
fit <- scale_amp_legacy(fit_mrs(metab, basis), wref)
a <- fit_amps(fit)
get <- function(n) if (n %in% colnames(a)) as.numeric(a[1, n]) * scale else NA
mi <- if ("Ins" %in% colnames(a)) get("Ins") else get("mI")
cat("tCr,tNAA,tCho,mI,Glx,water_td_amp\n")
cat(sprintf("%.3f,%.3f,%.3f,%.3f,%.3f,%.5g\n", get("tCr"), get("tNAA"), get("tCho"), mi, get("Glx"), as.numeric(get_td_amp(wref))))
