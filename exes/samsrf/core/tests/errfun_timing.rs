//! Native timing of one `prf::errfun` call, for comparison with the WebAssembly timing
//! that packages/samsrf/validation/parity.mjs prints. Same call: gaussian pRF, the
//! example's bar apertures scaled by 9.5, canonical HRF at TR 1, the function source
//! parsed on every call as the package's `errfun` does.
//!
//!   SAMSRF_EXAMPLE_DIR=.../X001 cargo test --release --test errfun_timing -- --ignored --nocapture

use samsrf_core::expr::AnonymousFunction;
use samsrf_core::hrf::{self, ErrfunHrf};
use samsrf_core::{mat, prf};
use std::time::Instant;

#[test]
#[ignore = "timing; needs SAMSRF_EXAMPLE_DIR"]
fn errfun_milliseconds_per_call() {
    let dir = std::env::var("SAMSRF_EXAMPLE_DIR").expect("SAMSRF_EXAMPLE_DIR names SamSrf's example subject");
    let bytes = std::fs::read(format!("{dir}/prf/aps_Bars.mat")).expect("prf/aps_Bars.mat");
    let apertures = mat::read_apertures(&bytes).expect("apertures");
    let xy = apertures.scaled_xy(9.5);
    let kernel = ErrfunHrf::Kernel(hrf::spm_canonical(1.0));
    let observed: Vec<f64> = (0..apertures.volumes()).map(|t| (t as f64 * 0.3).sin()).collect();
    let source = "@(P,ApWidth) prf_gaussian_rf(P(1),P(2),P(3),ApWidth)";
    let call = || {
        let function = AnonymousFunction::parse(source).expect("source parses");
        prf::errfun(&function, &apertures, &xy, &kernel, &[2.0, 1.0, 1.5], &observed, 1, false).expect("errfun")
    };
    for _ in 0..20 {
        call();
    }
    let (blocks, calls) = (10, 200);
    let ms = (0..blocks)
        .map(|_| {
            let start = Instant::now();
            for _ in 0..calls {
                std::hint::black_box(call());
            }
            start.elapsed().as_secs_f64() * 1000.0 / calls as f64
        })
        .fold(f64::INFINITY, f64::min);
    println!("errfun: {ms:.3} ms per call natively (fastest of {blocks} blocks of {calls} calls)");
}
