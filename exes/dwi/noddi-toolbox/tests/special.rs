// SPDX-License-Identifier: Apache-2.0
//! erfi and ln I0 against 50-digit mpmath values (tools/special_values.py), over the toolbox's
//! range: erfi(√kappa) for kappa up to 81 and the Rician log-likelihood's ln I0 below 700.

use dwi_amico::special::erfi;
use dwi_noddi_toolbox::rician::log_i0;

const ERFI: [(f64, f64); 22] = [
    (0.01, 0.011284167808628218),
    (0.1, 0.1132151741695998),
    (0.3, 0.3489493387589362),
    (0.5, 0.614952094696511),
    (1.0, 1.6504257587975428),
    (1.5, 4.584733257284427),
    (2.0, 18.564802414575553),
    (2.5, 130.39575501324694),
    (3.0, 1629.9946226015657),
    (3.5, 35282.28771517168),
    (4.0, 1296959.7307176392),
    (4.5, 80197458.90121748),
    (5.0, 8298273880.676804),
    (5.5, 1432099172039.8328),
    (5.7, 12964047613813.469),
    (6.0, 411275145582823.9),
    (6.5, 1.9622526775478406e+17),
    (7.0, 1.553486253460504e+20),
    (7.5, 2.038818719178621e+23),
    (8.0, 4.432449746002335e+26),
    (8.5, 1.5952980013947458e+30),
    (9.0, 9.500776643665995e+33),
];
const LOG_I0: [(f64, f64); 16] = [
    (0.0, 0.0),
    (1e-08, 2.5e-17),
    (0.001, 2.4999998437500175e-07),
    (0.5, 0.06154971918548131),
    (1.0, 0.23591435850717865),
    (3.75, 2.210354211972019),
    (8.0, 6.058104255427814),
    (15.0, 12.735669109476905),
    (29.9, 27.286385310555097),
    (30.0, 27.384701433171937),
    (30.1, 27.48302320895118),
    (50.0, 47.1275755018718),
    (100.0, 96.77973268994258),
    (250.0, 246.32083201205708),
    (500.0, 495.9740076681067),
    (699.9, 695.7057714576678),
];

#[test]
fn erfi_matches_high_precision_values() {
    for (x, want) in ERFI {
        let got = erfi(x);
        let error = ((got - want) / want).abs();
        assert!(
            error < 2e-14,
            "erfi({x}) = {got:e}, want {want:e} (relative error {error:e})"
        );
    }
}

#[test]
fn log_i0_matches_high_precision_values() {
    for (x, want) in LOG_I0 {
        let got = log_i0(x);
        let error = (got - want).abs() / want.abs().max(1e-300);
        assert!(
            error < 1e-14 || got == want,
            "ln I0({x}) = {got:e}, want {want:e} (relative error {error:e})"
        );
    }
}
