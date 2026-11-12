//! The double CSS pipeline end to end with the port's own HRF, against MATLAB's
//! maps at every vertex: `reference.json`'s pipeline_double_css and, when
//! `SAMSRF_MATLAB_CSS_PIPELINES_DIR` is set, the original-aperture and
//! nonnegative-aperture pipelines of `css-pipelines-reference.json` on its AMD host.
//!
//! - The port's de Haas HRF must equal MATLAB's recorded kernel bit for bit.
//! - Every map except Beta and Baseline must be bit-identical at every vertex.
//! - Every map row must keep MATLAB's NaN, infinity and zero masks: the same fits
//!   accepted, rejected and nonfinite.
//! - With `SAMSRF_CSS_WASM_REPORT` (compare-css.mjs's report), the committed
//!   WebAssembly's Beta and Baseline must be the native port's bits.
//! - Beta and Baseline are checked by [`coefficient_gate`], a stated policy rather
//!   than a derived error bound (see its documentation).
//!
//! `CSS_PIPELINE_REPORT=1` prints each differing coefficient's errors.
use num_complex::Complex64;
use num_rational::BigRational;
use num_traits::{One, Signed, ToPrimitive, Zero};
use samsrf_core::{
    css,
    expr::{AnonymousFunction, Value as Expression},
    fit_prf, hrf, job, mat, model, prf,
    timeseries::TimeSeries,
};
use serde_json::Value;
use std::path::{Path, PathBuf};

fn array(root: &Path, descriptor: &Value) -> Vec<f64> {
    let name = descriptor["file"].as_str().unwrap();
    assert_eq!(Path::new(name).file_name().unwrap(), name);
    let bytes = std::fs::read(root.join(name)).unwrap();
    let count: usize = descriptor["shape"].as_array().unwrap().iter().map(|n| n.as_u64().unwrap() as usize).product();
    assert_eq!(bytes.len(), count * 8, "{name}");
    bytes.as_chunks::<8>().0.iter().map(|b| f64::from_le_bytes(*b)).collect()
}

type Q = BigRational;

fn q(x: f64) -> Q {
    Q::from_float(x).expect("finite design, data and coefficients")
}

/// An exact complex rational.
#[derive(Clone, Debug)]
struct C(Q, Q);

impl C {
    fn real(x: Q) -> C {
        C(x, Q::zero())
    }
    fn from(x: Complex64) -> C {
        C(q(x.re), q(x.im))
    }
    fn add(&self, o: &C) -> C {
        C(&self.0 + &o.0, &self.1 + &o.1)
    }
    fn mul(&self, o: &C) -> C {
        C(&self.0 * &o.0 - &self.1 * &o.1, &self.0 * &o.1 + &self.1 * &o.0)
    }
    fn conj(&self) -> C {
        C(self.0.clone(), -self.1.clone())
    }
    fn div(&self, d: &Q) -> C {
        C(&self.0 / d, &self.1 / d)
    }
    fn norm_sqr(&self) -> Q {
        &self.0 * &self.0 + &self.1 * &self.1
    }
}

/// A nonnegative real with an unbounded binary exponent, `m * 2^e` with `m` in
/// [0.5, 1) or zero, so sensitivities of designs whose squares overflow or
/// underflow double are still finite and nonzero.
#[derive(Clone, Copy, Debug)]
struct E {
    m: f64,
    e: i64,
}

impl E {
    const ZERO: E = E { m: 0.0, e: 0 };
    fn new(m: f64, e: i64) -> E {
        assert!(m.is_finite() && m >= 0.0, "{m}");
        if m == 0.0 {
            return E::ZERO;
        }
        // Keep m normal before reading its exponent.
        let (m, e) = if m < f64::MIN_POSITIVE { (m * 2f64.powi(64), e - 64) } else { (m, e) };
        let bits = m.to_bits();
        let exponent = ((bits >> 52) & 0x7ff) as i64 - 1022;
        E { m: f64::from_bits((bits & !(0x7ff << 52)) | (1022 << 52)), e: e + exponent }
    }
    fn from_f64(x: f64) -> E {
        E::new(x.abs(), 0)
    }
    /// |q|, correct to a few ULP of the mantissa.
    fn from_q(x: &Q) -> E {
        let (n, d) = (x.numer().abs(), x.denom().clone());
        if n.is_zero() {
            return E::ZERO;
        }
        let shift = d.bits() as i64 - n.bits() as i64 + 64;
        let quotient = if shift >= 0 { (n << shift as usize) / d } else { n / (d << (-shift) as usize) };
        E::new(quotient.to_f64().unwrap(), -shift)
    }
    fn mul(self, o: E) -> E {
        E::new(self.m * o.m, self.e + o.e)
    }
    fn div(self, o: E) -> E {
        assert!(o.m > 0.0, "division by zero");
        E::new(self.m / o.m, self.e - o.e)
    }
    fn add(self, o: E) -> E {
        let (a, b) = if self.e >= o.e { (self, o) } else { (o, self) };
        if b.m == 0.0 || a.e - b.e > 1100 {
            return a;
        }
        E::new(a.m + b.m * 2f64.powi((b.e - a.e) as i32), a.e)
    }
    fn sqrt(self) -> E {
        if self.m == 0.0 {
            return E::ZERO;
        }
        if self.e % 2 == 0 { E::new(self.m.sqrt(), self.e / 2) } else { E::new((2.0 * self.m).sqrt(), (self.e - 1) / 2) }
    }
    /// `self <= o`.
    fn le(self, o: E) -> bool {
        if self.m == 0.0 || o.m == 0.0 {
            return self.m == 0.0;
        }
        (self.e, self.m) <= (o.e, o.m)
    }
    /// The value as a double, saturating to 0 or infinity outside its range.
    fn value(self) -> f64 {
        if self.m == 0.0 || self.e < -1100 {
            0.0
        } else if self.e > 1100 {
            f64::INFINITY
        } else {
            let half = (self.e / 2) as i32;
            self.m * 2f64.powi(half) * 2f64.powi(self.e as i32 - half)
        }
    }
}

/// The exact least-squares solution of `A b = y` for one or two complex columns.
struct Exact {
    /// The solution, exactly.
    b: Vec<C>,
    /// `(A^H A)^-1`, exactly.
    inverse: Vec<Vec<C>>,
    /// `A^H A`, exactly.
    gram: Vec<Vec<C>>,
    /// `||y - A b||^2`, exactly.
    residual: Q,
    /// `||y||^2`, exactly.
    data: Q,
}

fn dot(u: &[C], v: &[C]) -> C {
    let mut sum = C::real(Q::zero());
    for (u, v) in u.iter().zip(v) {
        sum = sum.add(&u.conj().mul(v));
    }
    sum
}

/// `A^H A` of complex columns, exactly.
fn gram(columns: &[Vec<Complex64>]) -> Vec<Vec<C>> {
    let a: Vec<Vec<C>> = columns.iter().map(|c| c.iter().map(|&x| C::from(x)).collect()).collect();
    a.iter().map(|u| a.iter().map(|v| dot(u, v)).collect()).collect()
}

fn exact(columns: &[Vec<Complex64>], y: &[f64]) -> Option<Exact> {
    let a: Vec<Vec<C>> = columns.iter().map(|c| c.iter().map(|&x| C::from(x)).collect()).collect();
    let y: Vec<C> = y.iter().map(|&y| C::real(q(y))).collect();
    let gram: Vec<Vec<C>> = a.iter().map(|u| a.iter().map(|v| dot(u, v)).collect()).collect();
    let aty: Vec<C> = a.iter().map(|u| dot(u, &y)).collect();
    let data = dot(&y, &y).0;
    let inverse = match a.len() {
        1 => {
            let g = &gram[0][0].0;
            if g.is_zero() {
                return None;
            }
            vec![vec![C::real(Q::one() / g)]]
        }
        2 => {
            let det = &gram[0][0].0 * &gram[1][1].0 - gram[0][1].norm_sqr();
            if det.is_zero() {
                return None;
            }
            // [g00 g01; g10 g11]^-1 = [g11 -g01; -g10 g00] / det
            let neg = |c: &C| C(-c.0.clone(), -c.1.clone());
            vec![vec![gram[1][1].div(&det), neg(&gram[0][1]).div(&det)], vec![neg(&gram[1][0]).div(&det), gram[0][0].div(&det)]]
        }
        _ => unreachable!(),
    };
    let b: Vec<C> = inverse.iter().map(|row| row.iter().zip(&aty).fold(C::real(Q::zero()), |s, (g, r)| s.add(&g.mul(r)))).collect();
    // ||y - A b||^2 = y^H y - b^H A^H y for the least-squares solution.
    let explained = b.iter().zip(&aty).fold(C::real(Q::zero()), |s, (b, r)| s.add(&b.conj().mul(r)));
    let residual = &data - &explained.0;
    Some(Exact { b, inverse, gram, residual, data })
}

/// MATLAB's numerical rank of `[1 x]`, decided in exact arithmetic.
#[derive(Debug, PartialEq)]
enum Rank {
    /// Both columns kept.
    Full,
    /// Only the pivot column (0 = ones, 1 = x) is kept; the other coefficient is 0.
    Deficient(usize),
}

/// MATLAB's `\` on a rectangular matrix keeps the leading pivoted columns whose
/// `|R_ii|` exceed `max(m, n) eps |R_11|` (ten times that for a complex design,
/// as `exes/samsrf/core/src/lstsq.rs` records from MATLAB's warnings), pivoting on
/// the largest column norm. Here `|R_11|` and `|R_22|` are computed exactly. The
/// rounded QR MATLAB runs perturbs `|R_22| / |R_11|` by rounding, so a ratio
/// within a factor of 2 of the tolerance, or column norms within 1e-12 of each
/// other (pivot choice), is not decided here: the gate fails instead of guessing.
/// The factor 2 is a policy, chosen with the band reported, not derived.
fn matlab_rank(gram: &[Vec<C>], m: usize, complex: bool) -> Result<(Rank, f64), String> {
    let (n0, n1) = (&gram[0][0].0, &gram[1][1].0);
    let p = if n1 > n0 { 1 } else { 0 };
    let np = &gram[p][p].0;
    let nq = &gram[1 - p][1 - p].0;
    // |R22|^2 / |R11|^2 = (n_q - |g_pq|^2 / n_p) / n_p
    let ratio = E::from_q(&((nq - gram[p][1 - p].norm_sqr() / np) / np)).sqrt();
    let tolerance = if complex { 10.0 } else { 1.0 } * m.max(2) as f64 * f64::EPSILON;
    let margin = ratio.div(E::from_f64(tolerance)).value();
    if margin <= 0.5 {
        // Which column is kept depends on the pivot, which rounded norms could
        // swap when the exact norms nearly tie.
        if E::from_q(&(n0 - n1)).le(E::from_q(&gram[p][p].0).mul(E::from_f64(1e-12))) {
            return Err("rank 1 with column norms within 1e-12 of each other: MATLAB's pivot is not decided".into());
        }
        Ok((Rank::Deficient(p), margin))
    } else if margin >= 2.0 {
        Ok((Rank::Full, margin))
    } else {
        Err(format!("UNDECIDED |R22|/|R11| is {margin} times MATLAB's rank tolerance: within the undecided band [0.5, 2]"))
    }
}

/// What the gate found for one vertex's coefficients.
#[derive(Debug, Default)]
struct Outcome {
    identical: usize,
    differing: usize,
    basic: usize,
    /// The largest (port error - MATLAB error) / scale.
    max_excess: f64,
    /// The largest port error / scale and MATLAB error / scale.
    max_port: f64,
    max_matlab: f64,
    /// u times the column-scaled condition number of the solved design.
    first_order: f64,
    /// |R22|/|R11| over MATLAB's tolerance (Full) or its inverse (Deficient).
    rank_margin: f64,
    /// 1 when the exact ratio fell in the undecided band and MATLAB's recorded
    /// zero pattern decided the rank.
    rank_from_recording: usize,
}

/// u times the column-scaled condition number above which the gate fails: a
/// policy margin for neglecting the expansion's higher-order terms.
const FIRST_ORDER_LIMIT: f64 = 1.0 / (1u64 << 20) as f64;

/// The policy for Beta and Baseline (`[Baseline, Beta]` of `[1 x] \ y`), which the
/// port's QR does not round as MKL does (#731):
///
/// 1. The rank and the pivot are MATLAB's rule evaluated exactly
///    ([`matlab_rank`]); where it gives rank 1, the coefficient of the other
///    column must be MATLAB's and the port's exact zero, and the kept one is
///    compared with the one-column solution. Where the exact ratio falls in the
///    undecided band, MATLAB's recorded zero pattern is taken as the rank
///    evidence instead, and such vertices are counted separately.
/// 2. A MATLAB zero without that rank deficiency fails.
/// 3. Each kept coefficient's errors are measured exactly: `|port - t|` and
///    `|MATLAB - t|` with `t` the real part of the exact least-squares solution in
///    rational arithmetic, not a rounded copy of it.
/// 4. The port's error may exceed MATLAB's by at most a scale `S`: the first-order
///    change of the coefficient when every column of the design and `y` moves by a
///    unit roundoff of its norm (Wedin's least-squares perturbation expansion,
///    Higham, Accuracy and Stability of Numerical Algorithms, 2nd ed., §20.1, per
///    coefficient). `S` is a scale, not a bound on any solver's error: it neglects
///    higher-order terms and assumes columnwise normwise perturbations. As a
///    validity condition for the first-order expansion, `u` times the
///    column-scaled condition number of the solved design must be at most 2^-20;
///    otherwise the gate fails.
fn coefficient_gate(x: &[Complex64], y: &[f64], port: [f64; 2], matlab: [f64; 2]) -> Result<Outcome, String> {
    let u = f64::EPSILON / 2.0;
    let ones = vec![Complex64::new(1.0, 0.0); x.len()];
    let both = [ones, x.to_vec()];
    let complex = x.iter().any(|v| v.im != 0.0);
    let mut outcome = Outcome::default();
    let rank = match matlab_rank(&gram(&both), x.len(), complex) {
        Ok((rank, margin)) => {
            outcome.rank_margin = if rank == Rank::Full { margin } else { 1.0 / margin };
            rank
        }
        // Inside the undecided band, MATLAB's recorded zero pattern is the rank
        // evidence: a basic solution's zero means rank 1, none means rank 2.
        Err(error) if error.starts_with("UNDECIDED") => {
            outcome.rank_from_recording = 1;
            match (0..2).find(|&k| matlab[k] == 0.0) {
                Some(zero) => Rank::Deficient(1 - zero),
                None => Rank::Full,
            }
        }
        Err(error) => return Err(error),
    };
    let kept: Vec<usize> = match rank {
        Rank::Full => {
            if let Some(k) = (0..2).find(|&k| matlab[k] == 0.0) {
                return Err(format!("MATLAB's coefficient {k} is zero, but [1 x] has full rank"));
            }
            vec![0, 1]
        }
        Rank::Deficient(p) => {
            let zero = 1 - p;
            if matlab[zero] != 0.0 || port[zero].to_bits() != matlab[zero].to_bits() {
                return Err(format!("rank 1 keeps column {p}: coefficient {zero} must be MATLAB's and the port's exact zero ({:e}, {:e})", matlab[zero], port[zero]));
            }
            outcome.basic = 1;
            vec![p]
        }
    };
    let columns: Vec<Vec<Complex64>> = kept.iter().map(|&k| both[k].clone()).collect();
    let solved = exact(&columns, y).ok_or("the kept columns are exactly singular")?;
    // Column-scaled condition: 1 for one column; for two, sqrt((1+c)/(1-c)) with
    // c the cosine between the columns, at most 2 / sqrt(1 - c^2).
    let first_order = if kept.len() == 1 {
        u
    } else {
        let sine2 = (&solved.gram[0][0].0 * &solved.gram[1][1].0 - solved.gram[0][1].norm_sqr()) / (&solved.gram[0][0].0 * &solved.gram[1][1].0);
        E::from_f64(2.0 * u).div(E::from_q(&sine2).sqrt()).value()
    };
    outcome.first_order = first_order;
    if first_order > FIRST_ORDER_LIMIT {
        return Err(format!("u times the scaled condition number is {first_order:e}: the first-order scale does not apply"));
    }
    let norms: Vec<E> = (0..kept.len()).map(|j| E::from_q(&solved.gram[j][j].0).sqrt()).collect();
    let data = E::from_q(&solved.data).sqrt();
    let residual = E::from_q(&solved.residual).sqrt();
    let size = solved.b.iter().zip(&norms).fold(data, |s, (b, n)| s.add(n.mul(E::from_q(&b.norm_sqr()).sqrt())));
    for (i, &k) in kept.iter().enumerate() {
        let g = |j: usize| E::from_q(&solved.inverse[i][j].norm_sqr()).sqrt();
        let scale = g(i).sqrt().mul(size).add((0..kept.len()).fold(E::ZERO, |s, j| s.add(g(j).mul(norms[j]))).mul(residual)).mul(E::from_f64(u));
        if port[k].to_bits() == matlab[k].to_bits() {
            outcome.identical += 1;
            continue;
        }
        let t = &solved.b[i].0;
        let (port_error, matlab_error) = ((q(port[k]) - t).abs(), (q(matlab[k]) - t).abs());
        let excess = &port_error - &matlab_error;
        let ratio = |v: &Q| E::from_q(v).div(scale).value();
        let excess_ratio = if excess.is_negative() { -ratio(&excess) } else { ratio(&excess) };
        outcome.differing += 1;
        outcome.max_excess = outcome.max_excess.max(excess_ratio);
        outcome.max_port = outcome.max_port.max(ratio(&port_error));
        outcome.max_matlab = outcome.max_matlab.max(ratio(&matlab_error));
        if excess_ratio > 1.0 {
            return Err(format!("coefficient {k}: the port's {:e} is further from the exact solution than MATLAB's {:e} by {excess_ratio} times the scale {}·2^{}", port[k], matlab[k], scale.m, scale.e));
        }
    }
    Ok(outcome)
}

struct Pipeline<'a> {
    label: &'a str,
    root: &'a Path,
    case: &'a Value,
    courses: Vec<f64>,
    ceiling: Option<Vec<f64>>,
    apertures: PathBuf,
    expected_hrf: Vec<f64>,
}

fn mask(value: f64) -> &'static str {
    if value.is_nan() {
        "NaN"
    } else if value.is_infinite() {
        if value > 0.0 { "+Inf" } else { "-Inf" }
    } else if value == 0.0 {
        "zero"
    } else {
        "finite"
    }
}

#[derive(Debug, Default)]
struct Coefficients {
    identical: usize,
    differing: usize,
    basic: usize,
    max_excess: f64,
    max_port: f64,
    max_matlab: f64,
    max_first_order: f64,
    min_rank_margin: f64,
    rank_from_recording: usize,
}

/// compare-css.mjs's report, when given.
fn wasm_report() -> Option<Value> {
    std::env::var_os("SAMSRF_CSS_WASM_REPORT").map(|file| serde_json::from_slice(&std::fs::read(file).unwrap()).unwrap())
}

/// Runs one pipeline and returns how its coefficients compare with MATLAB's.
fn check(p: Pipeline, wasm: Option<&Value>) -> Coefficients {
    let mut model_json = p.case["model"].clone();
    model_json["Data_Precision"] = "double".into();
    model_json["Css_Convention"] = "samsrf".into();
    let parsed = model::parse_model_json(model::AnalysisKind::Prf, &model_json.to_string()).unwrap();
    let apertures = mat::read_apertures(&std::fs::read(&p.apertures).unwrap()).unwrap();
    let volumes = 250;
    let vertices = p.courses.len() / volumes;
    let tr = model_json["TR"].as_f64().unwrap();
    let kernel = hrf::de_haas(tr);
    assert_eq!(kernel.iter().map(|v| v.to_bits()).collect::<Vec<_>>(), p.expected_hrf.iter().map(|v| v.to_bits()).collect::<Vec<_>>(), "{}: the port's HRF is MATLAB's", p.label);
    let inputs = job::JobInputs {
        model: parsed,
        apertures: Some(apertures.clone()),
        hrf: None,
        data: TimeSeries { volumes, vertices, data: p.courses.clone() },
        kept: (0..vertices as u32).collect(),
        roi: None,
        noise_ceiling: p.ceiling.clone(),
        global_signal: None,
        seed: None,
        surface: None,
        area: None,
        seed_fine_fit: None,
        total_vertices: vertices,
    };
    let prepared = job::Job::prepare(inputs, &mut |_, _| {}).unwrap();
    let partial = prepared.run(0, vertices, &mut |_| {}).unwrap();
    let maps = prepared.merge(&[partial]).unwrap().maps;
    let values: Vec<String> = p.case["values"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_string()).collect();
    assert_eq!(maps.values, values, "{}", p.label);
    let expected = array(p.root, &p.case["maps"]);
    let rows = values.len();
    let at = |name: &str, v: usize| expected[v * rows + values.iter().position(|n| n == name).unwrap()];
    let port = |name: &str, v: usize| maps.data[values.iter().position(|n| n == name).unwrap() * vertices + v];
    if let Some(report) = wasm {
        let case = &report["cases"][p.label];
        assert!(case.is_object(), "{}: missing from the WebAssembly report", p.label);
        for name in ["Beta", "Baseline"] {
            let wasm: Vec<u64> = case["coefficientBits"][name].as_array().unwrap().iter().map(|b| u64::from_str_radix(b.as_str().unwrap(), 16).unwrap()).collect();
            let native: Vec<u64> = (0..vertices).map(|v| port(name, v).to_bits()).collect();
            assert_eq!(wasm, native, "{}: the WebAssembly's {name} must equal the native port's", p.label);
        }
    }
    let function = AnonymousFunction::parse(model_json["Prf_Function"].as_str().unwrap()).unwrap();
    let xy = apertures.scaled_xy(model_json["Scaling_Factor"].as_f64().unwrap());
    let coordinates = fit_prf::xy_value(&xy);
    let mut stats = Coefficients { min_rank_margin: f64::INFINITY, ..Coefficients::default() };
    for v in 0..vertices {
        for name in &values {
            let (a, e) = (port(name, v), at(name, v));
            assert_eq!(mask(a), mask(e), "{} vertex {v} {name}: {a} vs MATLAB {e}", p.label);
            if name != "Beta" && name != "Baseline" {
                assert!(a.to_bits() == e.to_bits() || a.is_nan() && e.is_nan(), "{} vertex {v} {name}: {a} != {e}", p.label);
            }
        }
        let matlab = [at("Baseline", v), at("Beta", v)];
        if matlab == [0.0, 0.0] || matlab.iter().any(|c| !c.is_finite()) {
            // Rejected fits and nonfinite solutions: the masks above already matched.
            continue;
        }
        // The design MATLAB solved: every fitted parameter and the HRF are MATLAB's.
        let parameters: Vec<f64> = ["x0", "y0", "Sigma", "Exponent"].iter().map(|n| at(n, v)).collect();
        let profile = function.evaluate(&[Expression::column(parameters[..3].to_vec()), coordinates.clone()]).unwrap();
        let raw = prf::predict_timecourse(&profile.data, &apertures);
        let design = css::predict(&raw, parameters[3], &kernel, 1);
        let y = &p.courses[v * volumes..(v + 1) * volumes];
        let outcome = coefficient_gate(&design, y, [port("Baseline", v), port("Beta", v)], matlab).unwrap_or_else(|error| panic!("{} vertex {v}: {error}", p.label));
        if std::env::var_os("CSS_PIPELINE_REPORT").is_some() && (outcome.differing > 0 || outcome.rank_from_recording > 0) {
            eprintln!("{} vertex {v}: {outcome:?}", p.label);
        }
        stats.identical += outcome.identical;
        stats.differing += outcome.differing;
        stats.basic += outcome.basic;
        stats.max_excess = stats.max_excess.max(outcome.max_excess);
        stats.max_port = stats.max_port.max(outcome.max_port);
        stats.max_matlab = stats.max_matlab.max(outcome.max_matlab);
        stats.max_first_order = stats.max_first_order.max(outcome.first_order);
        if outcome.rank_from_recording == 0 {
            stats.min_rank_margin = stats.min_rank_margin.min(outcome.rank_margin);
        }
        stats.rank_from_recording += outcome.rank_from_recording;
    }
    stats
}

#[test]
fn double_css_pipeline_matches_matlab_with_the_ports_own_hrf() {
    let Some(root) = std::env::var_os("SAMSRF_MATLAB_REFERENCE_DIR").map(PathBuf::from) else {
        return;
    };
    let reference: Value = serde_json::from_slice(&std::fs::read(root.join("reference.json")).unwrap()).unwrap();
    let cases = reference["cases"].as_array().unwrap();
    let case = cases.iter().find(|c| c["id"] == "pipeline_double_css").unwrap();
    let pre = cases.iter().find(|c| c["id"] == case["preprocessing"]).unwrap();
    let stats = check(
        Pipeline {
            label: "reference.json pipeline_double_css",
            root: &root,
            case,
            courses: array(&root, &pre["courses"]),
            ceiling: Some(array(&root, &pre["noiseCeiling"])),
            apertures: root.join(format!("{}.mat", case["model"]["Aperture_File"].as_str().unwrap())),
            expected_hrf: array(&root, &case["hrf"]),
        },
        wasm_report().as_ref(),
    );
    eprintln!("pipeline_double_css: {stats:?}");
    // Exact counts, so that any change is reviewed rather than absorbed.
    assert_eq!((stats.identical, stats.differing, stats.basic, stats.rank_from_recording), (138, 0, 8, 3));
}

#[test]
fn recorded_original_and_nonnegative_css_pipelines_match_matlab() {
    let Some(root) = std::env::var_os("SAMSRF_MATLAB_CSS_PIPELINES_DIR").map(PathBuf::from) else {
        return;
    };
    let manifest: Value = serde_json::from_slice(&std::fs::read(root.join("manifest.json")).unwrap()).unwrap();
    let files = manifest["files"].as_object().unwrap();
    let hosts = manifest["hosts"].as_object().unwrap();
    let run = manifest["githubRun"].as_str().unwrap();
    assert_eq!(run, "https://github.com/neurodesk/webapps/actions/runs/43127425289");
    for host in hosts.keys() {
        // Provenance from inside the recording, not from file names: every process
        // ran the pipelines recorder in this run on the pinned SamSrf source.
        for process in ["compatible", "repeat"] {
            let dir = root.join(host).join(process);
            let environment: Value = serde_json::from_slice(&std::fs::read(dir.join("environment.json")).unwrap()).unwrap();
            assert_eq!(environment["githubRun"].as_str().map(|id| run.ends_with(&format!("/{id}"))), Some(true), "{host} {process}: run");
            assert_eq!(environment["executionMode"], "source-css-pipelines", "{host} {process}");
            assert_eq!(environment["source"]["commit"], "41ed1e96cc4d9b8b750f5594a61845df21ab8984", "{host} {process}");
            assert_eq!(environment["requested"]["MKL_CBWR"], "COMPATIBLE", "{host} {process}");
            assert_eq!(environment["observed"]["blas"], hosts[host]["blas"], "{host} {process}");
            assert!(environment["cpu"].as_str().unwrap().contains(hosts[host]["cpu"].as_str().unwrap()), "{host} {process}: CPU");
        }
        // The repeat in a new MATLAB process gives the same arrays.
        let prefix = format!("{host}/compatible/");
        let compared = files
            .iter()
            .filter(|(name, _)| name.starts_with(&prefix) && name.ends_with(".f64"))
            .map(|(name, hash)| assert_eq!(&files[&name.replace("/compatible/", "/repeat/")], hash, "{name}: repeat"))
            .count();
        assert_eq!(compared, 13, "{host}");
    }
    // MKL selects other kernels on Intel hosts (branch AVX512_E1 whatever is
    // requested), so only the AMD host is the reference the port models.
    let amd: Vec<&String> = hosts.iter().filter(|(_, info)| info["cpu"].as_str().unwrap().starts_with("AMD EPYC")).map(|(host, _)| host).collect();
    assert_eq!(amd.len(), 1, "one AMD host");
    assert!(hosts[amd[0]]["blas"].as_str().unwrap().ends_with("(CNR branch auto)"));
    let dir = root.join(amd[0]).join("compatible");
    let recording: Value = serde_json::from_slice(&std::fs::read(dir.join("pipelines.json")).unwrap()).unwrap();
    let report = wasm_report();
    let mut results = Vec::new();
    for case in recording["cases"].as_array().unwrap() {
        let id = case["id"].as_str().unwrap();
        assert_eq!(case["nonnegativeApertures"].as_bool(), Some(id.ends_with("_nonnegative")), "{id}");
        let label = format!("{} {id}", amd[0]);
        let stats = check(
            Pipeline {
                label: &label,
                root: &dir,
                case,
                courses: array(&dir, &case["courses"]),
                ceiling: case.get("noiseCeiling").map(|d| array(&dir, d)),
                apertures: dir.join(format!("{}.mat", case["model"]["Aperture_File"].as_str().unwrap())),
                expected_hrf: array(&dir, &case["hrf"]),
            },
            report.as_ref(),
        );
        eprintln!("{label}: {stats:?}");
        results.push((id.to_string(), stats.identical, stats.differing, stats.basic, stats.rank_from_recording));
    }
    assert_eq!(results, [("pipeline_double_css".to_string(), 138, 0, 8, 3), ("pipeline_double_css_nonnegative".to_string(), 125, 1, 8, 0)]);
}

// The gate itself, on synthetic least-squares problems: it must accept MATLAB's
// own coefficients and reject deliberate mutations.

/// A deterministic course: an affine function of `x` plus noise.
fn problem(m: usize, x: impl Fn(f64) -> Complex64, y: impl Fn(f64, Complex64) -> f64) -> (Vec<Complex64>, Vec<f64>) {
    let mut state = 0x2545_f491_4f6c_dd1du64;
    let mut next = || {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        (state >> 11) as f64 / (1u64 << 53) as f64 - 0.5
    };
    let xs: Vec<Complex64> = (0..m).map(|_| x(next())).collect();
    let ys: Vec<f64> = xs.iter().map(|&v| y(next(), v)).collect();
    (xs, ys)
}

/// The exact least-squares coefficients (real parts), rounded once: what an ideal
/// solver would return, with MATLAB's basic-solution zero where rank 1.
fn rounded(x: &[Complex64], y: &[f64]) -> [f64; 2] {
    let ones = vec![Complex64::new(1.0, 0.0); x.len()];
    match matlab_rank(&gram(&[ones.clone(), x.to_vec()]), x.len(), x.iter().any(|v| v.im != 0.0)).unwrap().0 {
        Rank::Full => {
            let full = exact(&[ones, x.to_vec()], y).unwrap();
            [full.b[0].0.to_f64().unwrap(), full.b[1].0.to_f64().unwrap()]
        }
        Rank::Deficient(p) => {
            let kept = exact(&[if p == 0 { ones } else { x.to_vec() }], y).unwrap().b[0].0.to_f64().unwrap();
            if p == 0 { [kept, 0.0] } else { [0.0, kept] }
        }
    }
}

fn ulps(x: f64, n: i64) -> f64 {
    f64::from_bits((x.to_bits() as i64 + n) as u64)
}

#[test]
fn gate_accepts_the_exact_coefficients_and_rejects_mutations() {
    let (x, y) = problem(250, |r| Complex64::new(1.5 + r, 0.3 * r), |r, x| 0.25 + 2.0 * x.re + 0.1 * r);
    let matlab = rounded(&x, &y);
    let ok = coefficient_gate(&x, &y, matlab, matlab).unwrap();
    assert_eq!((ok.identical, ok.differing, ok.basic), (2, 0, 0));
    // A one-ULP difference is within the scale; a large one is not.
    let near = coefficient_gate(&x, &y, [ulps(matlab[0], 1), ulps(matlab[1], -1)], matlab).unwrap();
    assert_eq!(near.differing, 2);
    assert!(near.max_excess <= 1.0 && near.max_excess > 0.0, "{near:?}");
    for k in 0..2 {
        let mut mutated = matlab;
        mutated[k] *= 1.0 + 1e-9;
        assert!(coefficient_gate(&x, &y, mutated, matlab).unwrap_err().contains("further from the exact solution"));
    }
    // MATLAB's error is excused only up to itself: a worse MATLAB value lets the
    // port be as bad, not worse by more than the scale.
    let mut worse = matlab;
    worse[1] *= 1.0 + 1e-9;
    let mut port = worse;
    port[1] = ulps(worse[1], 1);
    assert!(coefficient_gate(&x, &y, port, worse).is_ok());
    port[1] *= 1.0 + 1e-9;
    assert!(coefficient_gate(&x, &y, port, worse).is_err());
}

#[test]
fn gate_requires_the_exact_rank_decision_and_its_zero() {
    // x constant: [1 x] has rank 1 and the larger column, x, is the pivot.
    let (x, y) = problem(250, |_| Complex64::new(3.0, 0.0), |r, _| 1.0 + r);
    let matlab = rounded(&x, &y);
    assert_eq!(matlab[0], 0.0);
    let ok = coefficient_gate(&x, &y, matlab, matlab).unwrap();
    assert_eq!((ok.identical, ok.basic), (1, 1));
    // The port returns a value where MATLAB's basic solution has a zero.
    assert!(coefficient_gate(&x, &y, [1e-300, matlab[1]], matlab).unwrap_err().contains("exact zero"));
    // A zero on the wrong coefficient.
    assert!(coefficient_gate(&x, &y, [matlab[1] * 3.0, 0.0], [matlab[1] * 3.0, 0.0]).is_err());
    // A zero without rank deficiency.
    let (x, y) = problem(250, |r| Complex64::new(1.5 + r, 0.0), |r, x| 0.25 + 2.0 * x.re + 0.1 * r);
    let mut matlab = rounded(&x, &y);
    matlab[0] = 0.0;
    assert!(coefficient_gate(&x, &y, matlab, matlab).unwrap_err().contains("full rank"));
}

#[test]
fn gate_scales_survive_overflowing_and_subnormal_designs() {
    // Squares of 1e200 overflow double. Against such a column the ones column is
    // below MATLAB's rank tolerance, so Baseline is the basic solution's zero and
    // Beta the one-column solution.
    let (x, y) = problem(250, |r| Complex64::new(1e200 * (1.0 + r), 1e199 * r), |r, x| 3e-20 * x.re + 1e179 * r);
    let matlab = rounded(&x, &y);
    assert_eq!(matlab[0], 0.0);
    let ok = coefficient_gate(&x, &y, [0.0, ulps(matlab[1], 1)], matlab).unwrap();
    assert_eq!((ok.differing, ok.basic), (1, 1));
    assert!(ok.max_excess > 0.0 && ok.max_excess <= 1.0, "{ok:?}");
    let mut mutated = matlab;
    mutated[1] *= 1.0 + 1e-9;
    assert!(coefficient_gate(&x, &y, mutated, matlab).is_err());
    // Subnormal responses: [1 x] is rank deficient to MATLAB, x is dropped.
    let (x, y) = problem(250, |r| Complex64::new(1e-310 * (1.0 + r), 0.0), |r, _| 2.0 + r);
    let matlab = rounded(&x, &y);
    assert_eq!(matlab[1], 0.0);
    assert!(coefficient_gate(&x, &y, matlab, matlab).is_ok());
    // Subnormal data: Baseline is a subnormal mean. Its scale (about 1e-326) is
    // below the spacing of doubles, which the gate does not widen: the exact
    // value passes, and one ULP fails with a finite ratio, not a division by an
    // underflowed zero.
    let (x, y) = problem(250, |r| Complex64::new(1e-300 * (2.0 + r), 0.0), |r, x| 1e-310 + 1e-12 * x.re + 1e-311 * r);
    let matlab = rounded(&x, &y);
    assert!(matlab[0] != 0.0 && matlab[0].abs() < f64::MIN_POSITIVE && matlab[1] == 0.0, "{matlab:?}");
    let ok = coefficient_gate(&x, &y, matlab, matlab).unwrap();
    assert_eq!((ok.identical, ok.basic), (1, 1));
    let error = coefficient_gate(&x, &y, [ulps(matlab[0], 1), 0.0], matlab).unwrap_err();
    let ratio: f64 = error.split(" by ").nth(1).unwrap().split(' ').next().unwrap().parse().unwrap();
    assert!(ratio.is_finite() && ratio > 1.0, "{error}");
}

#[test]
fn gate_refuses_ill_conditioned_and_undecided_rank_designs() {
    // Nearly collinear with the ones column: full rank, but u times the scaled
    // condition number exceeds 2^-20, so the first-order scale does not apply.
    let (x, y) = problem(250, |r| Complex64::new(1.0 + 1e-11 * r, 0.0), |r, x| x.re + 0.1 * r);
    let matlab = [1.0, 1.0];
    assert!(coefficient_gate(&x, &y, matlab, matlab).unwrap_err().contains("first-order"));
    // |R22|/|R11| close to MATLAB's tolerance (x small and nearly orthogonal to
    // the ones column, so well conditioned): the exact rule does not decide the
    // rank, and MATLAB's recorded zero pattern does.
    let (x, y) = problem(250, |r| Complex64::new(1.9e-13 * r, 0.0), |r, x| 0.5 + 1e12 * x.re + r);
    let band = matlab_rank(&gram(&[vec![Complex64::new(1.0, 0.0); 250], x.clone()]), 250, false).unwrap_err();
    assert!(band.starts_with("UNDECIDED"), "{band}");
    let ones = vec![Complex64::new(1.0, 0.0); 250];
    let full = exact(&[ones.clone(), x.clone()], &y).unwrap();
    let both = [full.b[0].0.to_f64().unwrap(), full.b[1].0.to_f64().unwrap()];
    let ok = coefficient_gate(&x, &y, both, both).unwrap();
    assert_eq!((ok.identical, ok.rank_from_recording, ok.basic), (2, 1, 0));
    let basic = [exact(&[ones], &y).unwrap().b[0].0.to_f64().unwrap(), 0.0];
    let ok = coefficient_gate(&x, &y, basic, basic).unwrap();
    assert_eq!((ok.identical, ok.rank_from_recording, ok.basic), (1, 1, 1));
    // The port must follow the recorded decision.
    assert!(coefficient_gate(&x, &y, [basic[0], both[1]], basic).unwrap_err().contains("exact zero"));
}
