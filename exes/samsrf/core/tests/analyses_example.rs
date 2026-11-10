//! The three analyses end to end on the web app's example files (the flat directory
//! with lh_uBars1-6.gii, aps_Bars.mat, lh.V123.label, lh.V1_seed.label, lh_benson.gii,
//! lh.white, lh.area): a native smoke test with per-vertex timings.
//!
//!   SAMSRF_WEBAPP_EXAMPLE_DIR=/storage/scratch/samsrf-work/example \
//!     cargo test --release --test analyses_example -- --ignored --nocapture

use samsrf_core::job::{Job, JobInputs, SeedInputs};
use samsrf_core::model::{parse_model_json, AnalysisKind};
use samsrf_core::preprocess::{Combine, Normalise, PreprocessOptions, RunAccumulator};
use samsrf_core::timeseries::VertexSelection;
use samsrf_core::{freesurfer, gifti, mat, template};
use std::time::Instant;

const GAUSSIAN: &str = include_str!("data/Example_2D_Gaussian_pRF.json");
const REVCOR: &str = r#"{"Name":"pRF","Scaling_Factor":9.5,"TR":1,"Hrf":0,"Aperture_File":"aps_Bars"}"#;
const CF: &str = r#"{"Name":"CF_Rcp","SeedRoi":"lh.V1_seed","Template":"lh_benson"}"#;

struct Example {
    kept: Vec<u32>,
    roi: Vec<u32>,
    seed: Vec<u32>,
    data: samsrf_core::preprocess::Preprocessed,
    apertures_bytes: Vec<u8>,
    template: samsrf_core::mapset::Maps,
    area: Vec<f64>,
    surface: samsrf_core::surface::Surface,
}

fn load() -> Example {
    let dir = std::env::var("SAMSRF_WEBAPP_EXAMPLE_DIR").expect("SAMSRF_WEBAPP_EXAMPLE_DIR names the web app's example files");
    let read = |name: &str| std::fs::read(format!("{dir}/{name}")).unwrap_or_else(|_| panic!("{dir}/{name}"));
    let roi = freesurfer::read_label(&String::from_utf8(read("lh.V123.label")).unwrap()).unwrap().vertices;
    let seed = freesurfer::read_label(&String::from_utf8(read("lh.V1_seed.label")).unwrap()).unwrap().vertices;
    let mut kept = roi.clone();
    kept.extend(&seed);
    kept.sort_unstable();
    kept.dedup();
    let options = PreprocessOptions { normalise: Normalise::DetrendZscore, combine: Combine::Average { noise_ceiling: true }, global_signal: true, precision: samsrf_core::precision::Precision::Double };
    let mut accumulator = RunAccumulator::new(134260, VertexSelection::Indices(kept.clone()), options);
    for run in 1..=6 {
        let raw = gifti::read_run(&read(&format!("lh_uBars{run}.gii"))).unwrap();
        accumulator.push_run(&raw).unwrap();
    }
    let data = accumulator.finish().unwrap();
    let template = template::read_benson_gifti(&read("lh_benson.gii"), false).unwrap();
    let area = freesurfer::read_curv(&read("lh.area")).unwrap();
    let surface = freesurfer::read_surface(&read("lh.white")).unwrap();
    Example { kept, roi, seed, data, apertures_bytes: read("aps_Bars.mat"), template, area, surface }
}

fn inputs(example: &Example, kind: AnalysisKind, json: &str) -> JobInputs {
    let model = parse_model_json(kind, json).unwrap();
    JobInputs {
        model,
        apertures: Some(mat::read_apertures(&example.apertures_bytes).unwrap()),
        hrf: None,
        data: example.data.data.clone(),
        kept: example.kept.clone(),
        roi: Some(example.roi.clone()),
        noise_ceiling: example.data.noise_ceiling.clone(),
        global_signal: example.data.global_signal.clone(),
        seed: Some(SeedInputs { vertices: example.seed.clone(), template: example.template.clone() }),
        surface: Some(example.surface.clone()),
        area: Some(example.area.clone()),
        seed_fine_fit: None,
        total_vertices: 134260,
    }
}

fn run(name: &str, job: &Job, count: usize) {
    let count = count.min(job.vertex_count());
    let start = Instant::now();
    let half = count / 2;
    let first = job.run(0, half, &mut |_| {}).unwrap();
    let second = job.run(half, count, &mut |_| {}).unwrap();
    let seconds = start.elapsed().as_secs_f64();
    println!("{name}: {count} vertices in {seconds:.2} s ({:.2} ms per vertex)", seconds * 1000.0 / count as f64);
    let rest = job.run(count, job.vertex_count(), &mut |_| {}).unwrap();
    let merged = job.merge(&[second, first, rest]).unwrap();
    let r2 = merged.maps.row(0);
    let analysed = job.analysed();
    let good = analysed.iter().filter(|&&v| r2[v as usize] > 0.1).count();
    println!("  values {:?}; {} of {count} analysed vertices have row 0 > 0.1", merged.maps.values, good);
    for (row, value) in merged.maps.values.iter().enumerate() {
        let column: Vec<f64> = analysed[..count].iter().map(|&v| merged.maps.row(row)[v as usize]).collect();
        let finite: Vec<f64> = column.iter().copied().filter(|v| v.is_finite()).collect();
        let (min, max) = finite.iter().fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), &v| (lo.min(v), hi.max(v)));
        println!("  {value}: {} finite of {}, range {min:.4} .. {max:.4}", finite.len(), column.len());
    }
}

#[test]
#[ignore = "needs SAMSRF_WEBAPP_EXAMPLE_DIR"]
fn analyses_on_the_example() {
    let example = load();
    println!("{} kept vertices, {} ROI, {} seed, {} volumes", example.kept.len(), example.roi.len(), example.seed.len(), example.data.data.volumes);

    let start = Instant::now();
    let job = Job::prepare(inputs(&example, AnalysisKind::Prf, GAUSSIAN), &mut |_, _| {}).unwrap();
    println!("prf prepare (search space of the example grid): {:.2} s", start.elapsed().as_secs_f64());
    run("prf fit (Nelder-Mead)", &job, 40);

    let hj = GAUSSIAN.trim_end().trim_end_matches('}').to_string() + r#", "Hooke_Jeeves_Steps": [0.01, 0.01, 0.01]}"#;
    let job = Job::prepare(inputs(&example, AnalysisKind::Prf, &hj), &mut |_, _| {}).unwrap();
    run("prf fit (Hooke-Jeeves)", &job, 40);

    let coarse = GAUSSIAN.trim_end().trim_end_matches('}').to_string() + r#", "Coarse_Fit_Only": 1}"#;
    let job = Job::prepare(inputs(&example, AnalysisKind::Prf, &coarse), &mut |_, _| {}).unwrap();
    run("prf coarse only", &job, 400);

    let start = Instant::now();
    let job = Job::prepare(inputs(&example, AnalysisKind::RevCorPrf, REVCOR), &mut |_, _| {}).unwrap();
    println!("rc prepare: {:.2} s", start.elapsed().as_secs_f64());
    run("rc convex hull", &job, 200);

    let start = Instant::now();
    let job = Job::prepare(inputs(&example, AnalysisKind::RevCorCf, CF), &mut |_, _| {}).unwrap();
    println!("cf prepare: {:.2} s", start.elapsed().as_secs_f64());
    run("cf convex hull", &job, 400);
}
