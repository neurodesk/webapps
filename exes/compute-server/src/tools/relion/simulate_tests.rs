//! The simulated chain from import to postprocess, run in a temporary
//! project against a temporary data root: the files, blocks, columns and MRC
//! sizes of the protocol, and the reference check that fails a job.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde_json::{json, Value};

use super::*;
use crate::tools::project::ProjectCommand;
use crate::tools::relion::spec::{relion_command, validate_relion_spec};
use crate::tools::relion::star::parse_number;

const PROJECT: &str = "0123456789abcdef0123456789abcdef";

struct Fixture {
    _temp: tempfile::TempDir,
    project: std::path::PathBuf,
    root: std::path::PathBuf,
    roots: Vec<DataRoot>,
    next: u32,
}

struct Ran {
    end: SimulatedEnd,
    lines: Vec<String>,
    directory: String,
}

impl Fixture {
    fn new() -> Fixture {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        let root = temp.path().join("root");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::create_dir_all(root.join("grid")).unwrap();
        for name in ["a.tiff", "b.tiff", "c.tiff"] {
            std::fs::write(root.join("grid").join(name), "movie").unwrap();
        }
        std::fs::write(
            root.join("gain.mrc"),
            mrc::write(4, 4, 1, &[1.0; 16], 1.0, false, "gain"),
        )
        .unwrap();
        let roots = vec![DataRoot::parse(&format!("facility={}", root.display())).unwrap()];
        Fixture {
            _temp: temp,
            project,
            root,
            roots,
            next: 0,
        }
    }

    fn run_with(
        &mut self,
        command: &str,
        inputs: Value,
        options: Value,
        cancel_after: Option<usize>,
    ) -> Ran {
        let spec = json!({ "tool": "relion", "command": command, "project": PROJECT, "inputs": inputs, "options": options });
        let validated = validate_relion_spec(&spec, &[], None).unwrap();
        self.next += 1;
        let directory = format!("{}/job{:03}", validated.entry().job_type, self.next);
        std::fs::create_dir_all(self.project.join(&directory)).unwrap();
        let line = relion_command(&validated, &directory, 8, 0).unwrap();
        let ranks = line.launch.mpi_ranks;
        let mut main = vec![line.program];
        main.extend(line.args);
        let command = ProjectCommand {
            main,
            follow_up: line
                .then
                .into_iter()
                .map(|step| std::iter::once(step.program).chain(step.args).collect())
                .collect(),
        };
        let lines = Mutex::new(Vec::new());
        let cancelled = AtomicBool::new(false);
        let log = |line: String| lines.lock().unwrap().push(line);
        let pause = || {
            if cancel_after.is_some_and(|count| lines.lock().unwrap().len() >= count) {
                cancelled.store(true, Ordering::SeqCst);
            }
        };
        let is_cancelled = || cancelled.load(Ordering::SeqCst);
        let end = run(
            &validated,
            &SimulatedRun {
                project_dir: &self.project,
                directory: &directory,
                command: &command,
                launch: crate::tools::project::LaunchPlan {
                    ranks: (ranks > 1).then_some(ranks),
                    threads: 1,
                    gpus: 0,
                },
                data_roots: &self.roots,
                log: &log,
                pause: &pause,
                cancelled: &is_cancelled,
            },
        )
        .unwrap();
        Ran {
            end,
            lines: lines.into_inner().unwrap(),
            directory,
        }
    }

    fn run(&mut self, command: &str, inputs: Value, options: Value) -> Ran {
        let ran = self.run_with(command, inputs, options, None);
        assert_eq!(
            ran.end,
            SimulatedEnd::Exited(0),
            "{command}: {:?}",
            ran.lines
        );
        assert!(self
            .project
            .join(&ran.directory)
            .join("RELION_JOB_EXIT_SUCCESS")
            .is_file());
        ran
    }

    fn file(&self, path: &str) -> std::path::PathBuf {
        self.project.join(path)
    }

    fn star(&self, path: &str) -> Vec<Parsed> {
        parse_star(&std::fs::read_to_string(self.file(path)).unwrap()).unwrap()
    }

    fn table(&self, path: &str, block: &str) -> Table {
        self.star(path)
            .into_iter()
            .find(|parsed| parsed.name == block)
            .unwrap_or_else(|| panic!("{path} has data_{block}"))
            .table
    }

    fn mrc(&self, path: &str) -> MrcHeader {
        header_of(&self.file(path)).unwrap_or_else(|| panic!("{path} is MRC"))
    }
}

fn column(table: &Table, label: &str) -> Vec<String> {
    table
        .rows
        .iter()
        .map(|row| table.text(row, label).unwrap())
        .collect()
}

fn import(fixture: &mut Fixture, pattern: &str) -> Ran {
    fixture.run(
        "import",
        json!({ "movies": { "root": "facility", "path": "grid", "pattern": pattern } }),
        json!({ "angpix": 0.885, "kV": 200, "Cs": 1.4 }),
    )
}

#[test]
fn a_chain_from_import_to_postprocess_follows_real_references() {
    let mut fixture = Fixture::new();
    let imported = import(&mut fixture, "*.tiff");
    assert_eq!(
        imported.lines[0],
        "Simulated run of: ln -sfn /data/facility/grid Import/job001/data"
    );
    assert!(imported.lines[1].starts_with("Simulated run of: relion_import --do_movies"));
    assert_eq!(imported.lines[2], SIMULATED_WARNING);
    assert_eq!(level(&imported.lines[2]), LogLevel::Warning);
    let movies = fixture.table("Import/job001/movies.star", "movies");
    assert_eq!(
        column(&movies, "rlnMicrographMovieName"),
        [
            "Import/job001/data/a.tiff",
            "Import/job001/data/b.tiff",
            "Import/job001/data/c.tiff"
        ]
    );
    let optics = fixture.table("Import/job001/movies.star", "optics");
    assert_eq!(optics.columns.len(), 6);
    let run_out = std::fs::read_to_string(fixture.file("Import/job001/run.out")).unwrap();
    assert_eq!(run_out.lines().count(), imported.lines.len());
    assert_eq!(
        std::fs::read_to_string(fixture.file("Import/job001/run.err")).unwrap(),
        ""
    );

    let motion = fixture.run(
        "motioncorr",
        json!({ "movies": "Import/job001/movies.star", "gain": { "root": "facility", "path": "gain.mrc" } }),
        json!({ "dosePerFrame": 1.2 }),
    );
    assert!(motion.lines[0]
        .starts_with("Simulated run of: mpirun --bind-to none -np 2 relion_run_motioncorr_mpi "));
    let micrograph = fixture.mrc("MotionCorr/job002/Movies/a.mrc");
    assert_eq!((micrograph.nx, micrograph.ny, micrograph.nz), (64, 64, 1));
    let metadata = fixture.star("MotionCorr/job002/Movies/b.star");
    assert_eq!(
        metadata[0].pair("rlnMicrographGainName"),
        Some("/data/facility/gain.mrc")
    );
    let corrected = fixture.table(
        "MotionCorr/job002/corrected_micrographs.star",
        "micrographs",
    );
    assert_eq!(
        corrected.columns,
        [
            "rlnMicrographName",
            "rlnMicrographMetadata",
            "rlnOpticsGroup",
            "rlnAccumMotionTotal",
            "rlnAccumMotionEarly",
            "rlnAccumMotionLate",
            "rlnCtfPowerSpectrum"
        ]
    );
    assert!(fixture
        .table("MotionCorr/job002/corrected_micrographs.star", "optics")
        .columns
        .contains(&"rlnMicrographPixelSize".to_string()));

    fixture.run(
        "ctffind",
        json!({ "micrographs": "MotionCorr/job002/corrected_micrographs.star" }),
        json!({}),
    );
    let ctf = fixture.table("CtfFind/job003/micrographs_ctf.star", "micrographs");
    assert_eq!(
        column(&ctf, "rlnCtfImage")[0],
        "CtfFind/job003/Movies/a.ctf:mrc"
    );
    fixture.run(
        "autopick",
        json!({ "micrographs": "CtfFind/job003/micrographs_ctf.star" }),
        json!({}),
    );
    assert_eq!(
        fixture
            .table("AutoPick/job004/Movies/a_autopick.star", "")
            .rows
            .len(),
        4
    );
    fixture.run(
        "extract",
        json!({ "micrographs": "CtfFind/job003/micrographs_ctf.star", "coordinates": "AutoPick/job004/autopick.star" }),
        json!({}),
    );
    let particles = fixture.table("Extract/job005/particles.star", "particles");
    assert_eq!(particles.rows.len(), 12);
    assert_eq!(
        column(&particles, "rlnImageName")[5],
        "000002@Extract/job005/Movies/b.mrcs"
    );
    assert_eq!(
        column(&particles, "rlnMicrographName")[0],
        "MotionCorr/job002/Movies/a.mrc"
    );
    assert_eq!(fixture.mrc("Extract/job005/Movies/a.mrcs").nz, 4);

    let class2d = fixture.run(
        "class2d",
        json!({ "particles": "Extract/job005/particles.star" }),
        json!({ "nrClasses": 4, "nrIterGrad": 20 }),
    );
    let iterations: Vec<&String> = class2d
        .lines
        .iter()
        .filter(|line| line.contains("Gradient optimisation"))
        .collect();
    assert_eq!(iterations.len(), 5);
    assert_eq!(fixture.mrc("Class2D/job006/run_it020_classes.mrcs").nz, 4);
    let model = fixture.table("Class2D/job006/run_it020_model.star", "model_classes");
    assert_eq!(
        column(&model, "rlnReferenceImage")[3],
        "000004@Class2D/job006/run_it020_classes.mrcs"
    );

    fixture.run(
        "select",
        json!({ "particles": "Class2D/job006/run_it020_data.star" }),
        json!({ "mode": "classes", "classes": [3, 1] }),
    );
    assert!(fixture.file("Select/job007/classes_001_001.star").is_file());
    let selected = fixture.table("Select/job007/particles.star", "particles");
    assert_eq!(selected.rows.len(), 6);
    assert_eq!(column(&selected, "rlnClassNumber")[..3], ["1", "1", "1"]);

    let ranked = fixture.run(
        "select",
        json!({ "optimiser": "Class2D/job006/run_it020_optimiser.star" }),
        json!({ "mode": "ranker", "minScore": 0.6 }),
    );
    assert!(ranked.lines.last().unwrap().contains("from 2 classes"));
    assert_eq!(
        fixture
            .table("Select/job008/class_averages.star", "")
            .rows
            .len(),
        4
    );

    let initial = fixture.run(
        "initialmodel",
        json!({ "particles": "Select/job007/particles.star" }),
        json!({ "nrIter": 10 }),
    );
    assert!(initial.lines.iter().any(|line| line.starts_with(
        "Simulated run of: relion_align_symmetry --i InitialModel/job009/run_it010_model.star"
    )));
    assert_eq!(fixture.mrc("InitialModel/job009/initial_model.mrc").nz, 32);

    let refine = fixture.run(
        "refine3d",
        json!({ "particles": "Select/job007/particles.star", "reference": "InitialModel/job009/initial_model.mrc" }),
        json!({}),
    );
    assert!(refine.lines[0]
        .starts_with("Simulated run of: mpirun --bind-to none -np 3 relion_refine_mpi "));
    fixture.run(
        "maskcreate",
        json!({ "map": "Refine3D/job010/run_class001.mrc" }),
        json!({}),
    );
    assert_eq!(fixture.mrc("MaskCreate/job011/mask.mrc").nx, 32);
    let post = fixture.run(
        "postprocess",
        json!({ "halfMap": "Refine3D/job010/run_half1_class001_unfil.mrc", "mask": "MaskCreate/job011/mask.mrc" }),
        json!({}),
    );
    assert!(post
        .lines
        .iter()
        .any(|line| line.starts_with("  + FINAL RESOLUTION: ")));
    let general = fixture
        .star("PostProcess/job012/postprocess.star")
        .remove(0);
    assert_eq!(
        general.pair("rlnUnfilteredMapHalf2"),
        Some("Refine3D/job010/run_half2_class001_unfil.mrc")
    );
    assert!(parse_number(general.pair("rlnFinalResolution").unwrap()) > 0.0);
    assert_eq!(
        fixture
            .table("PostProcess/job012/postprocess.star", "fsc")
            .rows
            .len(),
        17
    );
    assert_eq!(
        fixture
            .table("PostProcess/job012/postprocess.star", "guinier")
            .rows
            .len(),
        16
    );
}

#[test]
fn a_reference_to_a_vanished_file_fails_the_job() {
    let mut fixture = Fixture::new();
    import(&mut fixture, "*.tiff");
    fixture.run(
        "motioncorr",
        json!({ "movies": "Import/job001/movies.star" }),
        json!({ "dosePerFrame": 1 }),
    );
    std::fs::remove_file(fixture.root.join("grid/b.tiff")).unwrap();
    let failed = fixture.run_with(
        "ctffind",
        json!({ "micrographs": "MotionCorr/job002/corrected_micrographs.star" }),
        json!({}),
        None,
    );
    let SimulatedEnd::Failed(message) = &failed.end else {
        panic!("{:?}", failed.end)
    };
    assert_eq!(
        message,
        "MotionCorr/job002/Movies/b.star references Import/job001/data/b.tiff, which does not exist"
    );
    let directory = fixture.project.join(&failed.directory);
    assert!(directory.join("RELION_JOB_EXIT_FAILURE").is_file());
    assert!(!directory.join("micrographs_ctf.star").exists());
    let err = std::fs::read_to_string(directory.join("run.err")).unwrap();
    assert_eq!(err, format!("ERROR: {message}\n"));
}

#[test]
fn image_indices_beyond_a_stack_fail() {
    let mut fixture = Fixture::new();
    import(&mut fixture, "a.tiff");
    fixture.run(
        "motioncorr",
        json!({ "movies": "Import/job001/movies.star" }),
        json!({ "dosePerFrame": 1 }),
    );
    fixture.run(
        "ctffind",
        json!({ "micrographs": "MotionCorr/job002/corrected_micrographs.star" }),
        json!({}),
    );
    fixture.run(
        "autopick",
        json!({ "micrographs": "CtfFind/job003/micrographs_ctf.star" }),
        json!({}),
    );
    fixture.run(
        "extract",
        json!({ "micrographs": "CtfFind/job003/micrographs_ctf.star", "coordinates": "AutoPick/job004/autopick.star" }),
        json!({}),
    );
    let stack = fixture.file("Extract/job005/Movies/a.mrcs");
    std::fs::write(
        &stack,
        mrc::write(32, 32, 3, &vec![0.0; 3 * 32 * 32], 1.0, true, "short"),
    )
    .unwrap();
    let failed = fixture.run_with(
        "class2d",
        json!({ "particles": "Extract/job005/particles.star" }),
        json!({}),
        None,
    );
    assert_eq!(
        failed.end,
        SimulatedEnd::Failed(
            "Extract/job005/particles.star references image 4 of Extract/job005/Movies/a.mrcs, which has 3".into()
        )
    );
}

#[test]
fn cancellation_stops_before_the_outputs_without_a_marker() {
    let mut fixture = Fixture::new();
    import(&mut fixture, "*.tiff");
    let cancelled = fixture.run_with(
        "motioncorr",
        json!({ "movies": "Import/job001/movies.star" }),
        json!({ "dosePerFrame": 1 }),
        Some(4),
    );
    assert_eq!(cancelled.end, SimulatedEnd::Cancelled);
    let directory = fixture.project.join(&cancelled.directory);
    assert!(directory.join("run.out").is_file());
    assert!(!directory.join("RELION_JOB_EXIT_SUCCESS").exists());
    assert!(!directory.join("RELION_JOB_EXIT_FAILURE").exists());
    assert!(!directory.join("corrected_micrographs.star").exists());
}

#[test]
fn references_outside_the_project_and_roots_are_refused() {
    let fixture = Fixture::new();
    let validated = validate_relion_spec(
        &json!({ "tool": "relion", "command": "class2d", "project": PROJECT, "inputs": { "particles": "Extract/job005/particles.star" } }),
        &[],
        None,
    )
    .unwrap();
    let job = Job {
        project_dir: fixture.project.canonicalize().unwrap(),
        directory: "Class2D/job006",
        validated: &validated,
        input_paths: Default::default(),
        roots: &fixture.roots,
    };
    assert_eq!(
        job.locate("/etc/passwd").unwrap_err(),
        "is an absolute path outside /project and /data"
    );
    assert_eq!(
        job.locate("/data/nope/x").unwrap_err(),
        "names data root nope, which the server does not have"
    );
    assert_eq!(
        job.locate("/data/facility/../project/x").unwrap_err(),
        "does not exist"
    );
    std::fs::write(fixture.project.join("inside"), "x").unwrap();
    assert_eq!(
        job.locate("/data/facility/../project/inside").unwrap_err(),
        "lies outside the project and the data roots"
    );
    assert_eq!(job.locate("").unwrap_err(), "is not a regular file");
    assert!(job.locate("/data/facility/grid/a.tiff").is_ok());
    assert!(Path::new(&job.locate("inside").unwrap()).is_file());
}

#[test]
fn log_lines_and_launch_lines() {
    assert_eq!(
        launch_line(
            &[
                "relion_refine".into(),
                "--gpu".into(),
                String::new(),
                "--i".into(),
                "a b$".into()
            ],
            3
        ),
        "mpirun --bind-to none -np 3 relion_refine --gpu \"\" --i \"a b\\$\""
    );
    assert_eq!(bar(1, 4), "  0.50/  2.00 sec ...............~~(,_,\">");
    assert_eq!(
        parse_reference("000003@Extract/job005/a.mrcs"),
        (Some(3), "Extract/job005/a.mrcs")
    );
    assert_eq!(
        parse_reference("CtfFind/job003/Movies/a.ctf:mrc"),
        (None, "CtfFind/job003/Movies/a.ctf")
    );
    assert_eq!(stem("/data/x/FoilHole_1.tiff"), "FoilHole_1");
    let resolution = fsc_resolution(1.0, 0.143);
    assert!(resolution > 2.0 && resolution < 3.0, "{resolution}");
}
