// SPDX-License-Identifier: MIT
//! Correctness comparison, not a performance benchmark. One thread, all eligible voxels.
use dwi_dmipy::Model;
use serde_json::{Value, json};
use std::{fs, path::Path};

fn values(value: &Value) -> Vec<f64> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_f64().unwrap())
        .collect()
}
fn doubles(path: &Path) -> Vec<f64> {
    let bytes = fs::read(path).unwrap();
    assert_eq!(bytes.len() % 8, 0);
    bytes
        .chunks_exact(8)
        .map(|v| f64::from_le_bytes(v.try_into().unwrap()))
        .collect()
}

fn main() {
    let args: Vec<_> = std::env::args().collect();
    assert!(
        args.len() == 3 || args.len() == 4,
        "full_reference PREPARED OUT [wm|MAX_VOXELS|INDEX,INDEX,...]"
    );
    let root = Path::new(&args[1]);
    let metadata: Value =
        serde_json::from_slice(&fs::read(root.join("prepared.json")).unwrap()).unwrap();
    let gradients = metadata["gradients"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| values(v).try_into().unwrap())
        .collect::<Vec<_>>();
    let bvals = values(&metadata["bvals"]);
    let model = Model::new(&bvals, &gradients).unwrap();
    let signals = doubles(&root.join("signals.f64"));
    let expected = doubles(&root.join("expected.f64"));
    let eligible = metadata["eligibleVoxels"].as_u64().unwrap() as usize;
    assert_eq!(signals.len(), eligible * bvals.len());
    assert_eq!(expected.len(), eligible * 6);
    let indices: Vec<usize> = match args.get(3) {
        Some(selection) if selection == "wm" => metadata["wmIndices"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_u64().unwrap() as usize)
            .collect(),
        Some(selection) if selection.contains(',') => {
            selection.split(',').map(|s| s.parse().unwrap()).collect()
        }
        selection => (0..selection
            .map(|s| s.parse::<usize>().unwrap().min(eligible))
            .unwrap_or(eligible))
            .collect(),
    };
    assert!(indices.iter().all(|&i| i < eligible));
    let count = indices.len();
    let mut differences = [vec![], vec![], vec![]];
    let mut failure_count = 0;
    let mut converged = 0;
    let mut maximum_iterations = 0;
    let mut maximum_mse_difference = 0.0_f64;
    let mut worst = [json!(null), json!(null), json!(null)];
    let mut maxima = [0.0; 3];
    for (done, &i) in indices.iter().enumerate() {
        match model.fit(&signals[i * bvals.len()..(i + 1) * bvals.len()]) {
            Ok(fit) => {
                converged += usize::from(fit.converged);
                maximum_iterations = maximum_iterations.max(fit.iterations);
                maximum_mse_difference =
                    maximum_mse_difference.max((fit.mse - expected[6 * i + 5]).abs());
                for (axis, row) in differences.iter_mut().enumerate() {
                    let error = (fit.parameters[axis + 2] - expected[6 * i + axis + 2]).abs();
                    row.push(error);
                    if error > maxima[axis] {
                        maxima[axis] = error;
                        worst[axis] = json!({"index": i, "coordinate": metadata["coordinates"][i],
                            "actual": fit.parameters[axis + 2], "expected": expected[6 * i + axis + 2],
                            "actualParameters": fit.parameters, "referenceParameters": expected[6 * i..6 * i + 5],
                            "start": fit.start, "mse": fit.mse, "referenceMSE": expected[6 * i + 5], "converged": fit.converged});
                    }
                }
            }
            Err(error) => {
                failure_count += 1;
                eprintln!("voxel{i}: {error}");
            }
        }
        if (done + 1) % 5000 == 0 {
            eprintln!("{}/{} voxels", done + 1, count);
        }
    }
    let maps = ["odi", "icvf", "isovf"].iter().enumerate().map(|(axis, &name)| {
        differences[axis].sort_by(f64::total_cmp);
        let errors = &differences[axis];
        let median = if errors.is_empty() { f64::NAN } else { (errors[(errors.len() - 1) / 2] + errors[errors.len() / 2]) * 0.5 };
        (name.to_owned(), json!({"medianAbsoluteDifference": median, "maxAbsoluteDifference": errors.last(),
            "voxelsAtOrAbove002": errors.iter().filter(|&&v| v >= 0.02).count(), "worst": worst[axis]}))
    }).collect::<serde_json::Map<_, _>>();
    let report = json!({"mode": "correctness under contention; not a benchmark", "reference": metadata["source"],
        "brainVoxels": metadata["brainVoxels"], "eligibleVoxels": eligible, "evaluatedVoxels": count,
        "failedFits": failure_count, "convergedFits": converged, "nonconvergedFits": count - failure_count - converged,
        "maximumIterations": maximum_iterations, "maximumMSEDifference": maximum_mse_difference,
        "maps": maps, "everyEvaluatedVoxelBelow002": failure_count == 0 && maxima.iter().all(|&v| v < 0.02),
        "wmSelection": metadata["wmSelection"], "gateSet": if args.get(3).is_some_and(|s| s == "wm") { "wm" } else { "brain or selected probe" }});
    fs::write(&args[2], serde_json::to_vec_pretty(&report).unwrap()).unwrap();
    println!("{}", serde_json::to_string_pretty(&report).unwrap());
    if failure_count > 0 {
        std::process::exit(1);
    }
}
