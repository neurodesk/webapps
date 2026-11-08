//! The interpreter against the fixtures `packages/cryo-em` generates from
//! `spec.js`: the same commands byte for byte, the same decisions and messages.

use serde_json::{json, Value};

use super::*;

const ARGV_CASES: &str =
    include_str!("../../../../../packages/cryo-em/test/fixtures/argv-cases.json");
const VALIDATION_CASES: &str =
    include_str!("../../../../../packages/cryo-em/test/fixtures/validation-cases.json");

fn parts_of(case: &Value) -> Vec<&str> {
    case["parts"]
        .as_array()
        .map(|parts| parts.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default()
}

fn profile_of(case: &Value) -> Option<(u32, u32)> {
    let profile = case.get("profile")?;
    Some((
        profile["cpus"].as_u64()? as u32,
        profile["gpus"].as_u64()? as u32,
    ))
}

fn command_json(command: &CommandLine) -> Value {
    json!({
        "program": command.program,
        "args": command.args,
        "mpiRanks": command.launch.mpi_ranks,
        "threads": command.launch.threads,
        "gpus": command.launch.gpus,
        "then": command.then.iter().map(|step| json!({ "program": step.program, "args": step.args })).collect::<Vec<_>>(),
    })
}

#[test]
fn argv_cases_match_spec_js_byte_for_byte() {
    let cases: Vec<Value> = serde_json::from_str(ARGV_CASES).unwrap();
    assert!(cases.len() >= 20);
    for case in &cases {
        let name = case["name"].as_str().unwrap();
        let profile = profile_of(case).unwrap();
        let validated = validate_relion_spec(&case["spec"], &parts_of(case), Some(profile))
            .unwrap_or_else(|error| panic!("{name}: {error}"));
        let directory = case["directory"].as_str().unwrap();
        let command = relion_command(&validated, directory, profile.0, profile.1)
            .unwrap_or_else(|error| panic!("{name}: {error}"));
        assert_eq!(command_json(&command), case["expected"], "{name}");
    }
}

// Numbers compare by value: spec.js keeps a number option as given, and JSON
// does not tell 200 from 200.0.
fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(a, b)| same(a, b))
        }
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len()
                && x.iter()
                    .all(|(key, a)| y.get(key).is_some_and(|b| same(a, b)))
        }
        _ => a == b,
    }
}

#[test]
fn validation_cases_reach_spec_js_decisions_and_messages() {
    let fixture: Value = serde_json::from_str(VALIDATION_CASES).unwrap();
    let cases = fixture["cases"].as_array().unwrap();
    assert!(cases.len() > 100);
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let result = validate_relion_spec(&case["spec"], &parts_of(case), profile_of(case));
        match (result, case.get("error")) {
            (Err(error), Some(expected)) => assert_eq!(error, expected.as_str().unwrap(), "{name}"),
            (Ok(validated), None) => {
                let actual = serde_json::to_value(&validated).unwrap();
                assert!(
                    same(&actual, &case["validated"]),
                    "{name}: {actual} != {}",
                    case["validated"]
                );
            }
            (Err(error), None) => panic!("{name}: refused with {error}"),
            (Ok(_), Some(expected)) => panic!("{name}: accepted, expected {expected}"),
        }
    }
}

#[test]
fn numbers_match_spec_js() {
    let fixture: Value = serde_json::from_str(VALIDATION_CASES).unwrap();
    for pair in fixture["numbers"].as_array().unwrap() {
        let value = pair[0].as_f64().unwrap();
        assert_eq!(relion_number(value), pair[1].as_str().unwrap(), "{value}");
    }
    assert_eq!(relion_number(-0.0), "0");
    assert_eq!(relion_number(123456.5), "123456");
    assert_eq!(relion_number(-0.000012345), "-1.2345e-05");
}

fn spec(command: &str, inputs: Value, options: Value) -> Value {
    json!({ "tool": "relion", "command": command, "project": "0123456789abcdef0123456789abcdef", "inputs": inputs, "options": options })
}

#[test]
fn integers_written_as_floats_are_integers() {
    let validated = validate_relion_spec(
        &spec(
            "class2d",
            json!({ "particles": "Extract/job005/particles.star" }),
            json!({ "nrClasses": 4.0, "nrIterGrad": 20.0 }),
        ),
        &[],
        None,
    )
    .unwrap();
    assert_eq!(validated.options["nrClasses"], json!(4));
    let command = relion_command(&validated, "Class2D/job006", 8, 0).unwrap();
    assert!(command.args.windows(2).any(|pair| pair == ["--K", "4"]));
    let outputs = relion_outputs(&validated).unwrap();
    assert_eq!(outputs[0], ("run_it020_data.star".to_string(), true));
}

#[test]
fn launch_rules() {
    assert_eq!(
        relion_launch("motioncorr", 18, 0).unwrap(),
        Launch {
            mpi_ranks: 4,
            threads: 4,
            gpus: 0
        }
    );
    assert_eq!(relion_launch("refine3d", 24, 4).unwrap().mpi_ranks, 5);
    assert_eq!(relion_launch("refine3d", 24, 2).unwrap().mpi_ranks, 3);
    assert_eq!(
        relion_launch("refine3d", 2, 0).unwrap_err(),
        "refine3d needs 3 MPI ranks with at least one CPU each; the profile has 2 CPUs"
    );
    assert_eq!(relion_launch("class2d", 24, 4).unwrap().threads, 24);
    assert_eq!(relion_launch("maskcreate", 8, 4).unwrap().gpus, 0);
}

#[test]
fn directories_must_match_the_job_type() {
    let validated = validate_relion_spec(
        &spec(
            "class2d",
            json!({ "particles": "Extract/job005/particles.star" }),
            json!({}),
        ),
        &[],
        None,
    )
    .unwrap();
    for directory in [
        "Class2D/job06",
        "Class3D/job006",
        "Class2D/job006/",
        "Class2D/jobabc",
    ] {
        assert_eq!(
            relion_command(&validated, directory, 8, 0).unwrap_err(),
            "directory must be Class2D/jobNNN",
            "{directory}"
        );
    }
    assert!(relion_command(&validated, "Class2D/job1006", 8, 0).is_ok());
}

#[test]
fn log_lines_have_levels_and_progress() {
    let stage = |text: &str| Some(text.to_string());
    let check =
        |command: &str, line: &str, level: LogLevel, progress: Option<(f64, Option<String>)>| {
            let (actual_level, actual) = parse_relion_log_line(command, line);
            assert_eq!(actual_level, level, "{line}");
            assert_eq!(
                actual.map(|(fraction, stage)| (fraction, Some(stage))),
                progress,
                "{line}"
            );
        };
    check(
        "class2d",
        " Gradient optimisation iteration 51 of 200 (Step size 0.3)",
        LogLevel::Info,
        Some((0.25, stage("2D classification: iteration 51 of 200"))),
    );
    check(
        "initialmodel",
        " Gradient optimisation iteration 1 of 100 with 2000 particles (Step size 0.5)",
        LogLevel::Info,
        Some((0.0, stage("Initial model: iteration 1 of 100"))),
    );
    check(
        "refine3d",
        " Auto-refine: Iteration= 5",
        LogLevel::Info,
        Some((0.2, stage("3D refinement: iteration 5"))),
    );
    check(
        "refine3d",
        " Auto-refine: Iteration= 40",
        LogLevel::Info,
        Some((0.9, stage("3D refinement: iteration 40"))),
    );
    check("refine3d", " Auto-refine: Refinement has converged, entering last iteration where two halves will be combined...", LogLevel::Info, Some((0.9, stage("3D refinement: final iteration"))));
    let bar = format!(
        "000/??? sec ~~(,_,\">          [oo]\r   3/  10 sec {}~~(,_,\">   [oo]\r   6/  10 sec {}~~(,_,\">    [oo]",
        ".".repeat(18),
        ".".repeat(36)
    );
    check(
        "ctffind",
        &bar,
        LogLevel::Info,
        Some((0.6, stage("CTF estimation"))),
    );
    check(
        "motioncorr",
        &format!(" 1.50/3.00 min {}~~(,_,\"> yum!", ".".repeat(60)),
        LogLevel::Info,
        Some((1.0, stage("Motion correction"))),
    );
    check(
        "class2d",
        &format!("   6/  10 sec {}~~(,_,\">", ".".repeat(36)),
        LogLevel::Info,
        None,
    );
    check(
        "postprocess",
        "  + FINAL RESOLUTION: 3.1",
        LogLevel::Info,
        None,
    );
    check("extract", "ERROR: cannot read file", LogLevel::Error, None);
    check(
        "refine3d",
        " Auto-refine: WARNING: Iter = 3 The angular accuracy is worse than 10 degrees",
        LogLevel::Warning,
        None,
    );
    check(
        "autopick",
        " Warning! no particles picked",
        LogLevel::Warning,
        None,
    );
    check(
        "autopick",
        "ERRORS are words only when whole; WARNINGS too",
        LogLevel::Info,
        None,
    );
}

#[test]
fn input_paths_inside_the_container() {
    let validated = validate_relion_spec(
        &json!({ "tool": "relion", "command": "motioncorr", "project": "0123456789abcdef0123456789abcdef",
                 "inputs": { "movies": "Import/job001/movies.star", "gain": { "root": "examples", "path": "relion-tutorial/Movies/gain.mrc" } },
                 "options": { "dosePerFrame": 1.277 } }),
        &[],
        None,
    )
    .unwrap();
    let paths = resolve_input_paths(&validated, "MotionCorr/job002");
    assert_eq!(
        paths["gain"],
        "/data/examples/relion-tutorial/Movies/gain.mrc"
    );
    assert_eq!(paths["movies"], "Import/job001/movies.star");
}
