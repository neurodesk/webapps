//! Haemodynamic response functions (`SamSrf/Hrf`) and convolution (`prf_convolve_hrf`).

use crate::error::{Error, Result};
use crate::model::HrfSpec;

/// SPM's canonical double-gamma parameters: response delay, undershoot delay, response
/// dispersion, undershoot dispersion, response/undershoot ratio, onset, kernel length.
pub const DOUBLE_GAMMA_DEFAULTS: [f64; 7] = [6.0, 16.0, 1.0, 1.0, 6.0, 0.0, 32.0];

/// The de Haas et al. (2014) fit `samsrf_hrf` uses: response delay, undershoot delay,
/// response/undershoot ratio, amplitude.
const DE_HAAS_PARAMS: [f64; 4] = [5.5278, 16.8621, 1.0205, 1.466];

/// `samsrf_doublegamma(TR, P)`: `p` replaces the leading defaults (up to seven values).
/// The kernel has `length(p(6):p(7)/TR)` samples spread by `linspace(p(6), p(7), L)`, so
/// its spacing is `32 / floor(32 / TR)` seconds, not exactly TR; reproduced on purpose.
/// MATLAB errors on more than seven values; here the extra values are ignored.
pub fn doublegamma(tr: f64, p: &[f64]) -> Vec<f64> {
    let mut q = DOUBLE_GAMMA_DEFAULTS;
    let given = p.len().min(q.len());
    q[..given].copy_from_slice(&p[..given]);
    let samples = colon_count(q[5], q[6] / tr);
    let response_shape = q[0] / q[2];
    let undershoot_shape = q[1] / q[3];
    linspace(q[5], q[6], samples)
        .into_iter()
        .map(|t| {
            let g1 = gampdf(t, response_shape, q[2]);
            let g2 = gampdf(t, undershoot_shape, q[3]) / q[4];
            g1 - g2
        })
        .collect()
}

/// `numel(a:b)` with unit step. Octave and MATLAB both floor `b - a` with a tolerance of
/// a few eps so that `0:2.9999999999999996` still has four elements.
fn colon_count(a: f64, b: f64) -> usize {
    let span = b - a;
    if span.is_nan() || span < 0.0 {
        return 0;
    }
    let tolerance = 3.0 * f64::EPSILON * a.abs().max(b.abs());
    (span + tolerance).floor() as usize + 1
}

/// MATLAB `linspace(a, b, n)`: `a + ((0:n-1) * (b - a)) / (n - 1)` with the last element
/// exactly `b`; one element is `b`.
fn linspace(a: f64, b: f64, n: usize) -> Vec<f64> {
    if n == 0 {
        return Vec::new();
    }
    if n == 1 {
        return vec![b];
    }
    let steps = (n - 1) as f64;
    let mut values: Vec<f64> = (0..n).map(|i| a + (i as f64 * (b - a)) / steps).collect();
    values[n - 1] = b;
    values
}

/// `samsrf_doublegamma(TR, [6 16 1 1 6 0 32])`: SPM's canonical HRF (`Hrf = 0`).
pub fn spm_canonical(tr: f64) -> Vec<f64> {
    doublegamma(tr, &DOUBLE_GAMMA_DEFAULTS)
}

/// `samsrf_hrf(TR)`: the de Haas et al. (2014) HRF, scaled to the canonical's peak (`Hrf = []`).
pub fn de_haas(tr: f64) -> Vec<f64> {
    let canonical = spm_canonical(tr);
    let canonical_sum: f64 = canonical.iter().sum();
    let canonical_peak = max(canonical.iter().map(|value| value / canonical_sum));
    let [response, undershoot, ratio, amplitude] = DE_HAAS_PARAMS;
    let hrf: Vec<f64> = doublegamma(tr, &[response, undershoot, 1.0, 1.0, ratio, 0.0, 32.0])
        .into_iter()
        .map(|value| value * amplitude)
        .collect();
    let peak = max(hrf.iter().copied());
    let scale = canonical_peak / peak;
    hrf.into_iter().map(|value| scale * value).collect()
}

/// MATLAB `max` of a vector: NaN elements are ignored unless every element is NaN.
fn max(values: impl Iterator<Item = f64>) -> f64 {
    values.fold(f64::NAN, f64::max)
}

/// The old-school `hrf_*.mat` form: `samsrf_doublegamma(TR, [fP(1:2) 1 1 fP(3) 0 32]) * fP(4)`.
pub fn old_school(tr: f64, fp: [f64; 4]) -> Vec<f64> {
    doublegamma(tr, &[fp[0], fp[1], 1.0, 1.0, fp[2], 0.0, 32.0])
        .into_iter()
        .map(|value| value * fp[3])
        .collect()
}

/// `gampdf(x, a, b)` as MATLAB defines it, including `x = 0` for every shape.
pub fn gampdf(x: f64, a: f64, b: f64) -> f64 {
    if x.is_nan() || a.is_nan() || b.is_nan() || a <= 0.0 || b <= 0.0 {
        return f64::NAN;
    }
    if x < 0.0 {
        return 0.0;
    }
    if x == 0.0 {
        if a < 1.0 {
            return f64::INFINITY;
        }
        if a == 1.0 {
            return 1.0 / b;
        }
        return 0.0;
    }
    ((a - 1.0) * x.ln() - x / b - libm::lgamma(a) - a * b.ln()).exp()
}

/// `prf_convolve_hrf(Y, Hrf, Downsampling)`: full convolution truncated to `y.len()`,
/// then every `downsampling`-th sample from the first when `downsampling > 1`.
pub fn convolve(y: &[f64], hrf: &[f64], downsampling: usize) -> Vec<f64> {
    let step = downsampling.max(1);
    (0..y.len())
        .step_by(step)
        .map(|k| {
            let terms = hrf.len().min(k + 1);
            (0..terms).map(|j| y[k - j] * hrf[j]).sum()
        })
        .collect()
}

/// What `prf_errfun` receives as `Hrf`: a kernel, or the negative TR that tells it
/// to build the kernel from the last five parameters.
#[derive(Debug, Clone, PartialEq)]
pub enum ErrfunHrf {
    Kernel(Vec<f64>),
    Fit { tr: f64 },
}

/// An HRF ready for the analyses: resolved from the model spec and the TR. File-backed
/// specs are resolved by the caller (it owns file access) and passed in as `Vector`.
#[derive(Debug, Clone, PartialEq)]
pub enum ResolvedHrf {
    Kernel(Vec<f64>),
    /// `Hrf = 1`
    None,
    /// `Hrf = Inf`
    Fit,
}

/// Resolves the specs that need no file: canonical, de Haas, none, fit and vectors.
/// `OldSchoolFile` and `VertexWiseFile` return `Error::Model` telling the caller to
/// load the file (`old_school` builds the kernel from its `fP`).
pub fn resolve(spec: &HrfSpec, tr: f64) -> Result<ResolvedHrf> {
    match spec {
        HrfSpec::SpmCanonical => Ok(ResolvedHrf::Kernel(spm_canonical(tr))),
        HrfSpec::DeHaas => Ok(ResolvedHrf::Kernel(de_haas(tr))),
        HrfSpec::None => Ok(ResolvedHrf::None),
        HrfSpec::Fit => Ok(ResolvedHrf::Fit),
        HrfSpec::Vector(kernel) if kernel.is_empty() => Ok(ResolvedHrf::Kernel(de_haas(tr))),
        HrfSpec::Vector(kernel) => Ok(ResolvedHrf::Kernel(kernel.clone())),
        HrfSpec::OldSchoolFile(file) => Err(Error::Model(format!(
            "Hrf {file} is an old-school HRF fit file: the caller must load its fP and call hrf::old_school"
        ))),
        HrfSpec::VertexWiseFile(file) => Err(Error::Model(format!(
            "Hrf {file} is a vertex-wise HRF fit map: the caller must load it"
        ))),
    }
}

#[cfg(test)]
#[allow(clippy::excessive_precision)]
mod tests {
    use super::*;

    // Expected values: Octave 9.2, preprocess-agent/hrf_expected.m (gampdf by its closed
    // form, MATLAB's linspace formula, samsrf_doublegamma and samsrf_hrf verbatim otherwise).
    const GAMPDF: &[f64] = &[
        0.066800942890542669,
        0.0046024976220330705,
        2.8444760217306314e-11,
        0.0017719045042601323,
        12.60935635549078,
    ];
    const SPM_TR2: &[f64] = &[
        0.0,
        0.036089408297886365,
        0.15629094533107124,
        0.16047459845428921,
        0.09009933169072562,
        0.032046929863623397,
        0.00067545204475492199,
        -0.012760399940665018,
        -0.015552907908972445,
        -0.012856103472527493,
        -0.0085531781586946944,
        -0.0048544530952974096,
        -0.0024266218746080686,
        -0.001091670643717335,
        -0.000449136382553466,
        -0.00017111394776742812,
        -6.0974770045128949e-05,
    ];
    const ONSET_TR1_5: &[f64] = &[
        0.079911017726848471,
        0.19511135015896733,
        0.18075223042872923,
        0.10613575983286384,
        0.043965935524454103,
        0.0068499296667319243,
        -0.01303687191082646,
        -0.022303430144045351,
        -0.024455789661658043,
        -0.022041629638438625,
        -0.017402604582868682,
        -0.01239251438093027,
        -0.0081044410802178432,
        -0.004930993361306305,
        -0.0028191999285514758,
        -0.0015267056446780507,
        -0.00078821444254094527,
        -0.00039006042320627505,
        -0.00018585757007398053,
    ];
    const DE_HAAS_TR2_55: &[f64] = &[
        0.0,
        0.34455966550820644,
        0.55190555493216242,
        0.22499903680382508,
        -0.042596466925398112,
        -0.23745633018016366,
        -0.31031434480724995,
        -0.24988859018410778,
        -0.14449543680809465,
        -0.065042192711808874,
        -0.024038351210708631,
        -0.0075747133398272474,
        -0.0020924505422474176,
    ];
    const OLD_SCHOOL_TR1: &[f64] = &[
        0.0,
        0.014056550176765849,
        0.11700899034816657,
        0.26689142954657613,
        0.35830347872633733,
        0.35969402304185505,
        0.30009943527613309,
        0.21938177833356892,
        0.14351349023538529,
        0.082696245467821033,
        0.037705927014367986,
        0.0058593075843901762,
        -0.015781370946471997,
        -0.029439321043625444,
        -0.036733823850543204,
        -0.039025415586287006,
        -0.037621085033570853,
        -0.033789517645841954,
        -0.028672598709253313,
        -0.02318915460368394,
        -0.017985027056552381,
        -0.013439605362670397,
        -0.0097129557559147966,
        -0.0068103519102291404,
        -0.004645160837370029,
        -0.0030892059118565848,
        -0.0020071649522655113,
        -0.0012763816654268979,
        -0.00079565266525623475,
        -0.00048688056165329486,
        -0.0002928361391206636,
        -0.00017330980533523097,
        -0.00010103303237839278,
    ];

    fn assert_close(actual: &[f64], expected: &[f64], tolerance: f64) {
        assert_eq!(actual.len(), expected.len(), "length");
        for (i, (a, e)) in actual.iter().zip(expected).enumerate() {
            assert!(
                a == e || (a - e).abs() <= tolerance * e.abs(),
                "element {i}: {a} vs {e}"
            );
        }
    }

    #[test]
    fn gampdf_matches_octave_closed_form() {
        let actual = [
            gampdf(2.5, 6.0, 1.0),
            gampdf(7.3, 16.0, 1.0),
            gampdf(0.01, 5.4166, 1.0205),
            gampdf(30.0, 16.8621, 1.0),
            gampdf(1e-3, 0.5, 2.0),
        ];
        assert_close(&actual, GAMPDF, 1e-12);
    }

    #[test]
    fn gampdf_edge_cases_follow_matlab() {
        assert_eq!(gampdf(0.0, 0.5, 2.0), f64::INFINITY);
        assert_eq!(gampdf(0.0, 1.0, 4.0), 0.25);
        assert_eq!(gampdf(0.0, 6.0, 1.0), 0.0);
        assert_eq!(gampdf(-1.0, 6.0, 1.0), 0.0);
        assert!(gampdf(f64::NAN, 6.0, 1.0).is_nan());
        assert!(gampdf(1.0, 0.0, 1.0).is_nan());
        assert!(gampdf(1.0, 6.0, -1.0).is_nan());
    }

    #[test]
    fn kernel_length_is_the_matlab_colon_count() {
        // (TR, numel(0:32/TR), numel(2:32/TR)) from Octave.
        let cases = [
            (1.0, 33, 31),
            (2.0, 17, 15),
            (2.55, 13, 11),
            (3.0, 11, 9),
            (0.5, 65, 63),
            (1.5, 22, 20),
            (0.7, 46, 44),
            (0.1, 321, 319),
            (32.0 / 3.0, 4, 2),
            (0.3, 107, 105),
            (1.6, 21, 19),
            (0.8, 41, 39),
        ];
        for (tr, from_zero, from_two) in cases {
            assert_eq!(spm_canonical(tr).len(), from_zero, "TR {tr}");
            assert_eq!(
                doublegamma(tr, &[6.0, 16.0, 1.0, 1.0, 6.0, 2.0, 32.0]).len(),
                from_two,
                "TR {tr} onset 2"
            );
        }
    }

    #[test]
    fn doublegamma_matches_samsrf() {
        assert_close(&spm_canonical(2.0), SPM_TR2, 1e-12);
        assert_close(
            &doublegamma(1.5, &[5.0, 15.0, 0.9, 1.1, 4.0, 2.0, 30.0]),
            ONSET_TR1_5,
            1e-12,
        );
    }

    #[test]
    fn partial_parameters_keep_the_remaining_defaults() {
        assert_eq!(doublegamma(2.0, &[6.0, 16.0]), spm_canonical(2.0));
        let eight = [6.0, 16.0, 1.0, 1.0, 6.0, 0.0, 32.0, 99.0];
        assert_eq!(doublegamma(2.0, &eight), spm_canonical(2.0));
    }

    #[test]
    fn de_haas_matches_samsrf_hrf() {
        assert_close(&de_haas(2.55), DE_HAAS_TR2_55, 1e-12);
    }

    #[test]
    fn old_school_matches_its_doublegamma_form() {
        assert_close(
            &old_school(1.0, [5.5, 15.5, 5.0, 2.0]),
            OLD_SCHOOL_TR1,
            1e-12,
        );
    }

    #[test]
    fn convolve_truncates_and_downsamples() {
        let y = [0.0, 1.0, 0.0, 0.0, 2.0, 1.0, 0.0, 0.0, 0.0, 3.0, 1.0, 0.0];
        let kernel = [0.5, 1.0, 0.25];
        assert_eq!(
            convolve(&y, &kernel, 1),
            [0.0, 0.5, 1.0, 0.25, 1.0, 2.5, 1.5, 0.25, 0.0, 1.5, 3.5, 1.75]
        );
        assert_eq!(convolve(&y, &kernel, 0), convolve(&y, &kernel, 1));
        assert_eq!(
            convolve(&y, &[0.5, 1.0, 0.25, -0.125, 2.0], 3),
            [0.0, 0.25, 1.5, 3.5]
        );
    }

    #[test]
    fn resolve_maps_every_spec() {
        assert_eq!(
            resolve(&HrfSpec::SpmCanonical, 2.0),
            Ok(ResolvedHrf::Kernel(spm_canonical(2.0)))
        );
        assert_eq!(
            resolve(&HrfSpec::DeHaas, 2.55),
            Ok(ResolvedHrf::Kernel(de_haas(2.55)))
        );
        assert_eq!(
            resolve(&HrfSpec::Vector(Vec::new()), 2.55),
            Ok(ResolvedHrf::Kernel(de_haas(2.55)))
        );
        assert_eq!(
            resolve(&HrfSpec::Vector(vec![1.0, 0.5]), 2.0),
            Ok(ResolvedHrf::Kernel(vec![1.0, 0.5]))
        );
        assert_eq!(resolve(&HrfSpec::None, 2.0), Ok(ResolvedHrf::None));
        assert_eq!(resolve(&HrfSpec::Fit, 2.0), Ok(ResolvedHrf::Fit));
        let Err(Error::Model(message)) =
            resolve(&HrfSpec::OldSchoolFile("hrf_sub01.mat".into()), 2.0)
        else {
            panic!("an old-school file must ask the caller to load it");
        };
        assert!(message.contains("hrf_sub01.mat"));
        let Err(Error::Model(message)) =
            resolve(&HrfSpec::VertexWiseFile("lh_hrf.mat".into()), 2.0)
        else {
            panic!("a vertex-wise file must ask the caller to load it");
        };
        assert!(message.contains("lh_hrf.mat"));
    }
}
