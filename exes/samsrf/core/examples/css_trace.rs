//! Compare a recorded MATLAB CSS trace with the native port at identical inputs.
//! Usage: css_trace REFERENCE_DIR DIAGNOSTICS_DIR CASE_ID REPORT_JSON
//! This reports differences; it does not turn diagnostic cases into parity gates.
use num_complex::Complex64;
use samsrf_core::{
    css,
    expr::{AnonymousFunction, Value as Expression},
    fit_prf, hrf, mat, optim,
    precision::Precision,
    prf,
};
use serde_json::{Value, json};
use std::{fs, path::Path};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

fn read_json(path: impl AsRef<Path>) -> Result<Value> {
    Ok(serde_json::from_slice(&fs::read(path)?)?)
}

fn array(root: &Path, descriptor: &Value) -> Result<Vec<f64>> {
    let name = descriptor["file"].as_str().ok_or("missing array file")?;
    if Path::new(name).file_name().and_then(|s| s.to_str()) != Some(name) {
        return Err("reference array paths must be flat".into());
    }
    let bytes = fs::read(root.join(name))?;
    let size = descriptor["shape"]
        .as_array()
        .ok_or("missing shape")?
        .iter()
        .try_fold(1usize, |n, d| n.checked_mul(d.as_u64()? as usize))
        .ok_or("invalid shape")?;
    if bytes.len() != size * 8 {
        return Err("array size differs from its descriptor".into());
    }
    Ok(bytes
        .as_chunks::<8>()
        .0
        .iter()
        .map(|bytes| f64::from_le_bytes(*bytes))
        .collect())
}

fn complex_array(root: &Path, descriptor: &Value) -> Result<Vec<Complex64>> {
    let real = array(root, descriptor)?;
    let imaginary = match descriptor["imaginary"].as_str().filter(|s| !s.is_empty()) {
        Some(name) => array(root, &json!({"file":name,"shape":descriptor["shape"]}))?,
        None => vec![0.0; real.len()],
    };
    Ok(real
        .into_iter()
        .zip(imaginary)
        .map(|(re, im)| Complex64::new(re, im))
        .collect())
}

#[derive(Default)]
struct Difference {
    compared: usize,
    differing: usize,
    nonfinite: usize,
    maximum_absolute: f64,
    first: Option<Value>,
}

impl Difference {
    fn add(
        &mut self,
        actual: f64,
        expected: f64,
        evaluation: usize,
        element: usize,
        component: &str,
    ) {
        self.compared += 1;
        if actual.to_bits() == expected.to_bits() || actual.is_nan() && expected.is_nan() {
            return;
        }
        self.differing += 1;
        if !actual.is_finite() || !expected.is_finite() {
            self.nonfinite += 1;
        } else {
            self.maximum_absolute = self.maximum_absolute.max((actual - expected).abs());
        }
        if self.first.is_none() {
            self.first = Some(
                json!({"evaluation":evaluation,"element":element,"component":component,
                "actual":actual.to_string(),"expected":expected.to_string()}),
            );
        }
    }

    fn values(&mut self, actual: &[Complex64], expected: &[Complex64], evaluation: usize) {
        assert_eq!(actual.len(), expected.len());
        for (element, (a, e)) in actual.iter().zip(expected).enumerate() {
            self.add(a.re, e.re, evaluation, element, "real");
            self.add(a.im, e.im, evaluation, element, "imaginary");
        }
    }

    fn report(&self) -> Value {
        json!({"compared":self.compared,"differing":self.differing,"nonfiniteDifferences":self.nonfinite,
            "maximumAbsolute":self.maximum_absolute,"first":self.first})
    }
}

fn main() -> Result<()> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.len() != 4 {
        return Err("Usage: css_trace REFERENCE_DIR DIAGNOSTICS_DIR CASE_ID REPORT_JSON".into());
    }
    let reference = Path::new(&args[0]);
    let diagnostics = Path::new(&args[1]);
    let recording = read_json(diagnostics.join("diagnostics.json"))?;
    if recording["smoke"] == true {
        return Err("Octave smoke traces are not MATLAB references".into());
    }
    let case = recording["cases"]
        .as_array()
        .ok_or("missing cases")?
        .iter()
        .find(|case| case["id"] == args[2])
        .ok_or("missing requested trace")?;
    if case["kind"] != "css-trace" || case["fineFitRun"] != true {
        return Err("case is not an executed CSS fit".into());
    }
    let precision = match case["precision"].as_str() {
        Some("single") => Precision::Single,
        Some("double") => Precision::Double,
        _ => return Err("missing explicit trace precision".into()),
    };
    let pipeline = read_json(reference.join(format!(
        "{}.json",
        case["pipeline"].as_str().ok_or("missing pipeline")?
    )))?;
    if pipeline["precision"] != case["precision"] {
        return Err("pipeline precision mismatch".into());
    }
    let model = &pipeline["model"];
    let mut apertures = mat::read_apertures(&fs::read(reference.join(format!(
        "{}.mat",
        model["Aperture_File"].as_str().ok_or("missing apertures")?
    )))?)?;
    if case["nonnegativeApertures"] == true {
        for frame in &mut apertures.frames {
            for value in &mut frame.values {
                *value = value.max(0.0);
            }
        }
    }
    let xy = apertures.scaled_xy(
        model["Scaling_Factor"]
            .as_f64()
            .ok_or("missing scaling factor")?,
    );
    let coordinates = fit_prf::xy_value(&xy);
    let function =
        AnonymousFunction::parse(model["Prf_Function"].as_str().ok_or("missing profile")?)?;
    let kernel = array(reference, &pipeline["hrf"])?;
    let downsampling = model["Downsample_Predictions"]
        .as_u64()
        .ok_or("missing downsampling")? as usize;
    let observed = array(diagnostics, &case["observations"])?;
    let seed = array(diagnostics, &case["seed"])?;
    let parameters = array(diagnostics, &case["trace"])?;
    let evaluations = case["trace"]["shape"][0]
        .as_u64()
        .ok_or("missing trace shape")? as usize;
    if parameters.len() != evaluations * seed.len() {
        return Err("trace parameter count mismatch".into());
    }
    let expected_raw = complex_array(diagnostics, &case["rawTrace"])?;
    let expected_compressed = complex_array(diagnostics, &case["compressedTrace"])?;
    let expected_prediction = complex_array(diagnostics, &case["predictionTrace"])?;
    let expected_error = complex_array(diagnostics, &case["errors"])?;
    if expected_raw.len() != evaluations * apertures.volumes()
        || expected_compressed.len() != expected_raw.len()
        || expected_prediction.len() != evaluations * observed.len()
        || expected_error.len() != evaluations
    {
        return Err("stage array shape mismatch".into());
    }
    let mut raw_diff = Difference::default();
    let mut compressed_diff = Difference::default();
    let mut prediction_diff = Difference::default();
    let mut objective_diff = Difference::default();
    for evaluation in 0..evaluations {
        let p: Vec<_> = (0..seed.len())
            .map(|i| parameters[i * evaluations + evaluation])
            .collect();
        let profile = function.evaluate(&[Expression::column(p.clone()), coordinates.clone()])?;
        let raw = prf::predict_timecourse(&profile.data, &apertures);
        let compressed: Vec<_> = raw
            .iter()
            .map(|&value| css::power(value, *p.last().unwrap()))
            .collect();
        let predicted = css::predict(&raw, *p.last().unwrap(), &kernel, downsampling);
        let error = css::objective(&predicted, &observed, precision);
        let raw_start = evaluation * raw.len();
        let prediction_start = evaluation * predicted.len();
        raw_diff.values(
            &raw.iter()
                .map(|&v| Complex64::new(v, 0.0))
                .collect::<Vec<_>>(),
            &expected_raw[raw_start..raw_start + raw.len()],
            evaluation,
        );
        compressed_diff.values(
            &compressed,
            &expected_compressed[raw_start..raw_start + raw.len()],
            evaluation,
        );
        prediction_diff.values(
            &predicted,
            &expected_prediction[prediction_start..prediction_start + predicted.len()],
            evaluation,
        );
        objective_diff.values(
            &[error],
            &expected_error[evaluation..evaluation + 1],
            evaluation,
        );
    }
    let mut native_trace = Vec::new();
    let result = optim::fminsearch(
        |p| {
            native_trace.push(p.to_vec());
            prf::errfun_with_convention(
                &function,
                &apertures,
                &xy,
                &hrf::ErrfunHrf::Kernel(kernel.clone()),
                p,
                &observed,
                downsampling,
                true,
                precision,
                css::Convention::Samsrf,
            )
            .unwrap()
        },
        &seed,
        &optim::FminsearchOptions {
            tol_x: model["Nelder_Mead_Tolerance"].as_f64().unwrap_or(1e-4),
            stop_when_not_finite: true,
            ..Default::default()
        },
    );
    let mut branch_diff = Difference::default();
    let common_evaluations = native_trace.len().min(evaluations);
    for (evaluation, p) in native_trace[..common_evaluations].iter().enumerate() {
        for (element, &actual) in p.iter().enumerate() {
            branch_diff.add(
                actual,
                parameters[element * evaluations + evaluation],
                evaluation,
                element,
                "parameter",
            );
        }
    }
    let first_unmatched = if native_trace.len() > evaluations {
        Some(
            json!({"side":"native","evaluation":evaluations,"parameters":native_trace[evaluations]}),
        )
    } else if evaluations > native_trace.len() {
        let p: Vec<_> = (0..seed.len())
            .map(|i| parameters[i * evaluations + native_trace.len()])
            .collect();
        Some(json!({"side":"MATLAB","evaluation":native_trace.len(),"parameters":p}))
    } else {
        None
    };
    let report = json!({"case":args[2],"execution":"native Rust","precision":case["precision"],
        "parityAsserted":false,"matlabEnvironment":recording["environment"],
        "sameParameters":{"raw":raw_diff.report(),"compressed":compressed_diff.report(),
            "prediction":prediction_diff.report(),"objective":objective_diff.report()},
        "optimizer":{"nativeEvaluations":native_trace.len(),"matlabEvaluations":evaluations,
            "unmatchedEvaluations":{"native":native_trace.len()-common_evaluations,"matlab":evaluations-common_evaluations},
            "firstUnmatchedEvaluation":first_unmatched,
            "parameters":branch_diff.report(),"resultParameters":result.x,
            "resultObjective":{"real":result.fval.re.to_string(),"imaginary":result.fval.im.to_string()}}});
    fs::write(&args[3], serde_json::to_string_pretty(&report)? + "\n")?;
    println!(
        "Wrote {}. Differences are diagnostics, not accepted tolerances.",
        args[3]
    );
    Ok(())
}
