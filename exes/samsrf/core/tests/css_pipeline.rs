//! The double CSS pipeline end to end with the port's own HRF, against MATLAB's
//! maps at every vertex: `reference.json`'s pipeline_double_css and, when
//! `SAMSRF_MATLAB_CSS_PIPELINES_DIR` is set, the original-aperture and
//! nonnegative-aperture pipelines of `css-pipelines-reference.json`.
//!
//! - The port's de Haas HRF must equal MATLAB's recorded kernel bit for bit.
//! - Every map except Beta and Baseline must be bit-identical at every vertex.
//! - Every map row must keep MATLAB's NaN, infinity and zero masks: the same fits
//!   accepted, rejected and nonfinite.
//! - Where MATLAB's `\` returned a basic solution (one coefficient exactly zero
//!   because it found `[1 x]` rank deficient), the port must return the same zero.
//! - Beta and Baseline otherwise come from a QR solve whose rounding the port does
//!   not reproduce bit for bit (#731). Each must be no further from the exact
//!   least-squares solution than MATLAB's, plus the coefficient's inherent
//!   double-precision uncertainty: its first-order change when every input
//!   column moves by one unit roundoff of its norm. The exact solution is computed
//!   in rational arithmetic from the design, which equals MATLAB's because every
//!   fitted parameter and the HRF do. This limit depends only on the problem, not
//!   on any observed difference.
//!
//! `CSS_PIPELINE_REPORT=1` prints each differing coefficient's errors.
use num_complex::Complex64;
use samsrf_core::{
    css, expr::{AnonymousFunction, Value as Expression}, fit_prf, hrf, job, mat, model, prf,
    timeseries::TimeSeries,
};
use num_rational::BigRational;
use num_traits::{One, ToPrimitive, Zero};
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
    Q::from_float(x).expect("finite design and data")
}

/// An exact complex rational.
#[derive(Clone)]
struct C(Q, Q);

impl C {
    fn from(x: Complex64) -> C {
        C(q(x.re), q(x.im))
    }
    fn conj_mul(&self, o: &C) -> C {
        // conj(self) * o
        C(&self.0 * &o.0 + &self.1 * &o.1, &self.0 * &o.1 - &self.1 * &o.0)
    }
    fn mul(&self, o: &C) -> C {
        C(&self.0 * &o.0 - &self.1 * &o.1, &self.0 * &o.1 + &self.1 * &o.0)
    }
    fn sub(&self, o: &C) -> C {
        C(&self.0 - &o.0, &self.1 - &o.1)
    }
    fn scale(&self, d: &Q) -> C {
        C(&self.0 / d, &self.1 / d)
    }
    fn round(&self) -> Complex64 {
        Complex64::new(self.0.to_f64().unwrap(), self.1.to_f64().unwrap())
    }
}

/// The exact complex least-squares solution of `A b = y` for one or two columns,
/// each part rounded once to double, and the inverse normal matrix
/// `G = (A^H A)^-1` rounded to double (magnitudes). None when `A` is rank deficient.
fn exact_solution(columns: &[Vec<Complex64>], y: &[f64]) -> Option<(Vec<Complex64>, Vec<Vec<f64>>)> {
    let a: Vec<Vec<C>> = columns.iter().map(|c| c.iter().map(|&x| C::from(x)).collect()).collect();
    let y: Vec<C> = y.iter().map(|&y| C(q(y), Q::zero())).collect();
    let dot = |u: &[C], v: &[C]| u.iter().zip(v).fold(C(Q::zero(), Q::zero()), |s, (u, v)| {
        let p = u.conj_mul(v);
        C(s.0 + p.0, s.1 + p.1)
    });
    let f = |v: &Q| v.to_f64().unwrap();
    let norm = |c: &C| f(&(&c.0 * &c.0 + &c.1 * &c.1)).sqrt();
    match a.len() {
        1 => {
            let g = dot(&a[0], &a[0]).0;
            if g.is_zero() {
                return None;
            }
            let b = dot(&a[0], &y).scale(&g);
            Some((vec![b.round()], vec![vec![f(&(Q::one() / g))]]))
        }
        2 => {
            let (g00, g01, g11) = (dot(&a[0], &a[0]).0, dot(&a[0], &a[1]), dot(&a[1], &a[1]).0);
            let (r0, r1) = (dot(&a[0], &y), dot(&a[1], &y));
            let det = &g00 * &g11 - (&g01.0 * &g01.0 + &g01.1 * &g01.1);
            if det.is_zero() {
                return None;
            }
            // [g00 g01; conj(g01) g11]^-1 = [g11 -g01; -conj(g01) g00] / det
            let b0 = C(&g11 * &r0.0, &g11 * &r0.1).sub(&g01.mul(&r1)).scale(&det);
            let conj01 = C(g01.0.clone(), -g01.1.clone());
            let b1 = C(&g00 * &r1.0, &g00 * &r1.1).sub(&conj01.mul(&r0)).scale(&det);
            let off = norm(&g01.scale(&det));
            Some((vec![b0.round(), b1.round()], vec![vec![f(&(&g11 / &det)), off], vec![off, f(&(&g00 / &det))]]))
        }
        _ => unreachable!(),
    }
}

/// The first-order change in each coefficient of `min ||A b - y||` when every
/// column of `A` and `y` moves by at most one unit roundoff of its norm (Wedin's
/// perturbation of least squares, Higham, Accuracy and Stability of Numerical
/// Algorithms, 2nd ed., section 20.1, bounded per coefficient): the uncertainty any
/// double-precision solver inherits from storing its inputs.
fn sensitivity(columns: &[Vec<Complex64>], y: &[f64], b: &[Complex64], g: &[Vec<f64>]) -> Vec<f64> {
    let u = f64::EPSILON / 2.0;
    let norms: Vec<f64> = columns.iter().map(|c| c.iter().map(|v| v.norm_sqr()).sum::<f64>().sqrt()).collect();
    let data = y.iter().map(|v| v * v).sum::<f64>().sqrt();
    let residual = (0..y.len()).map(|t| (y[t] - columns.iter().zip(b).map(|(c, b)| b * c[t]).sum::<Complex64>()).norm_sqr()).sum::<f64>().sqrt();
    // ||e_i^T A^+|| = sqrt(G_ii) because A^+ A^+^H = G.
    let scale = data + norms.iter().zip(b).map(|(n, b)| n * b.norm()).sum::<f64>();
    (0..b.len()).map(|i| u * (g[i][i].sqrt() * scale + g[i].iter().zip(&norms).map(|(g, n)| g * n).sum::<f64>() * residual)).collect()
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

struct Pipeline<'a> {
    label: &'a str,
    root: &'a Path,
    case: &'a Value,
    courses: Vec<f64>,
    ceiling: Option<Vec<f64>>,
    apertures: PathBuf,
    expected_hrf: Vec<f64>,
    /// compare-css.mjs's report: the committed WebAssembly's coefficients must be
    /// these same bits.
    wasm: Option<Value>,
}

#[derive(Debug, Default)]
struct Coefficients {
    identical: usize,
    differing: usize,
    rank_deficient: usize,
    /// Coefficients MATLAB set to exactly zero in a basic solution.
    basic: usize,
    /// The largest amount by which the port's error exceeds MATLAB's, in units of
    /// the coefficient's inherent double-precision uncertainty.
    max_excess: f64,
}

/// Runs one pipeline and returns how its coefficients compare with MATLAB's.
fn check(p: Pipeline) -> Coefficients {
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
    let function = AnonymousFunction::parse(model_json["Prf_Function"].as_str().unwrap()).unwrap();
    let xy = apertures.scaled_xy(model_json["Scaling_Factor"].as_f64().unwrap());
    let coordinates = fit_prf::xy_value(&xy);
    if let Some(report) = &p.wasm {
        for name in ["Beta", "Baseline"] {
            let wasm: Vec<u64> = report["coefficientBits"][name].as_array().unwrap().iter().map(|b| u64::from_str_radix(b.as_str().unwrap(), 16).unwrap()).collect();
            let native: Vec<u64> = (0..vertices).map(|v| port(name, v).to_bits()).collect();
            assert_eq!(wasm, native, "{}: the WebAssembly's {name} must equal the native port's", p.label);
        }
    }
    let mut stats = Coefficients::default();
    for v in 0..vertices {
        for name in &values {
            let (a, e) = (port(name, v), at(name, v));
            assert_eq!(mask(a), mask(e), "{} vertex {v} {name}: {a} vs MATLAB {e}", p.label);
            if name != "Beta" && name != "Baseline" {
                assert!(a.to_bits() == e.to_bits() || a.is_nan() && e.is_nan(), "{} vertex {v} {name}: {a} != {e}", p.label);
            }
        }
        let (beta, baseline) = (at("Beta", v), at("Baseline", v));
        if beta == 0.0 && baseline == 0.0 || !beta.is_finite() || !baseline.is_finite() {
            // Rejected fits and nonfinite solutions: the masks above already matched.
            continue;
        }
        let parameters: Vec<f64> = ["x0", "y0", "Sigma", "Exponent"].iter().map(|n| at(n, v)).collect();
        let profile = function.evaluate(&[Expression::column(parameters[..3].to_vec()), coordinates.clone()]).unwrap();
        let raw = prf::predict_timecourse(&profile.data, &apertures);
        let design = css::predict(&raw, parameters[3], &kernel, 1);
        let y = &p.courses[v * volumes..(v + 1) * volumes];
        // MATLAB's `\\` returns a basic solution, with an exact zero, when it finds
        // `[1 x]` rank deficient within its tolerance; the port must make the same
        // choice, and the kept coefficient is then the one-column solution.
        let mut columns = Vec::new();
        let mut names = Vec::new();
        if baseline != 0.0 {
            columns.push(vec![Complex64::new(1.0, 0.0); volumes]);
            names.push("Baseline");
        }
        if beta != 0.0 {
            columns.push(design);
            names.push("Beta");
        }
        for name in ["Beta", "Baseline"] {
            if at(name, v) == 0.0 {
                assert_eq!(port(name, v).to_bits(), at(name, v).to_bits(), "{} vertex {v} {name}: MATLAB's basic solution has an exact zero", p.label);
                stats.basic += 1;
            }
        }
        let Some((solution, inverse)) = exact_solution(&columns, y) else {
            for name in names {
                assert_eq!(port(name, v).to_bits(), at(name, v).to_bits(), "{} vertex {v} {name}: rank-deficient design", p.label);
            }
            stats.rank_deficient += 1;
            continue;
        };
        let sensitivity = sensitivity(&columns, y, &solution, &inverse);
        for (k, name) in names.into_iter().enumerate() {
            let (truth, limit) = (solution[k].re, sensitivity[k]);
            let (a, e) = (port(name, v), at(name, v));
            if a.to_bits() == e.to_bits() {
                stats.identical += 1;
                continue;
            }
            let excess = ((a - truth).abs() - (e - truth).abs()) / limit;
            if std::env::var_os("CSS_PIPELINE_REPORT").is_some() {
                eprintln!("{} vertex {v} {name}: port error {:.3}, MATLAB error {:.3}, in units of the inherent uncertainty {limit:e}", p.label, (a - truth).abs() / limit, (e - truth).abs() / limit);
            }
            assert!(excess <= 1.0, "{} vertex {v} {name}: the port's {a:e} is further from the exact {truth:e} than MATLAB's {e:e} by {excess} times the inherent uncertainty {limit:e}", p.label);
            stats.differing += 1;
            stats.max_excess = stats.max_excess.max(excess);
        }
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
    let stats = check(Pipeline {
        label: "reference.json pipeline_double_css",
        root: &root,
        case,
        courses: array(&root, &pre["courses"]),
        ceiling: Some(array(&root, &pre["noiseCeiling"])),
        apertures: root.join(format!("{}.mat", case["model"]["Aperture_File"].as_str().unwrap())),
        expected_hrf: array(&root, &case["hrf"]),
        wasm: std::env::var_os("SAMSRF_CSS_WASM_REPORT").map(|file| serde_json::from_slice(&std::fs::read(file).unwrap()).unwrap()),
    });
    eprintln!("pipeline_double_css: {stats:?}");
    // Exact counts, so that any change is reviewed rather than absorbed.
    assert_eq!((stats.identical, stats.differing, stats.basic, stats.rank_deficient), (77, 61, 8, 0));
}

#[test]
fn recorded_original_and_nonnegative_css_pipelines_match_matlab() {
    let Some(root) = std::env::var_os("SAMSRF_MATLAB_CSS_PIPELINES_DIR").map(PathBuf::from) else {
        return;
    };
    let manifest: Value = serde_json::from_slice(&std::fs::read(root.join("manifest.json")).unwrap()).unwrap();
    let files = manifest["files"].as_object().unwrap();
    let hosts = manifest["hosts"].as_object().unwrap();
    // Each host's repeat in a new MATLAB process must be the same reference.
    for host in hosts.keys() {
        let prefix = format!("{host}/compatible/");
        let compared = files.iter().filter(|(name, _)| name.starts_with(&prefix) && name.ends_with(".f64")).map(|(name, hash)| {
            assert_eq!(&files[&name.replace("/compatible/", "/repeat/")], hash, "{name}: repeat");
        }).count();
        assert_eq!(compared, 13, "{host}");
    }
    // MKL selects other kernels on Intel hosts (branch AVX512_E1 whatever is
    // requested), so only AMD hosts are the reference the port models.
    let amd: Vec<&String> = hosts.iter().filter(|(_, info)| info["cpu"].as_str().unwrap().starts_with("AMD EPYC")).map(|(host, _)| host).collect();
    assert_eq!(amd.len(), 1, "one AMD host");
    let dir = root.join(amd[0]).join("compatible");
    let recording: Value = serde_json::from_slice(&std::fs::read(dir.join("pipelines.json")).unwrap()).unwrap();
    let mut results = Vec::new();
    for case in recording["cases"].as_array().unwrap() {
        let label = format!("{} {}", amd[0], case["id"].as_str().unwrap());
        let stats = check(Pipeline {
            label: &label,
            root: &dir,
            case,
            courses: array(&dir, &case["courses"]),
            ceiling: case.get("noiseCeiling").map(|d| array(&dir, d)),
            apertures: dir.join(format!("{}.mat", case["model"]["Aperture_File"].as_str().unwrap())),
            expected_hrf: array(&dir, &case["hrf"]),
            wasm: None,
        });
        eprintln!("{label}: {stats:?}");
        results.push((case["id"].as_str().unwrap().to_string(), stats.identical, stats.differing, stats.basic, stats.rank_deficient));
    }
    assert_eq!(results, [
        ("pipeline_double_css".to_string(), 77, 61, 8, 0),
        ("pipeline_double_css_nonnegative".to_string(), 70, 56, 8, 0),
    ]);
}
