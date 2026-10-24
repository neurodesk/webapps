use super::*;
use fastprep_core::{bids, block_on};

struct Fixture(PathBuf);

impl Fixture {
    fn new(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("fastprep-{name}-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }

    fn path(&self, name: &str) -> String {
        self.0.join(name).to_str().unwrap().to_string()
    }

    fn host(&self) -> Native {
        Native {
            bin: PathBuf::new(),
            env: vec![],
            gpu_slots: 0,
            gpu_lock_dir: self.0.clone(),
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

fn bold() -> Vec<u8> {
    let mut bytes = vec![0u8; 352];
    bytes[0..4].copy_from_slice(&348i32.to_le_bytes());
    for (i, dim) in [4i16, 1, 1, 1, 120, 1, 1, 1].iter().enumerate() {
        bytes[40 + 2 * i..42 + 2 * i].copy_from_slice(&dim.to_le_bytes());
    }
    bytes[70..72].copy_from_slice(&16i16.to_le_bytes());
    bytes[72..74].copy_from_slice(&32i16.to_le_bytes());
    for i in 0..8 {
        bytes[76 + 4 * i..80 + 4 * i].copy_from_slice(&1f32.to_le_bytes());
    }
    bytes[108..112].copy_from_slice(&352f32.to_le_bytes());
    bytes[344..348].copy_from_slice(b"n+1\0");
    for t in 0..120 {
        let value = 100.0 + 2.0 * (t as f32 * 0.13).sin() + (t as f32 * 1.7).cos();
        bytes.extend(value.to_le_bytes());
    }
    bytes
}

#[test]
fn discovery_requires_positive_numeric_repetition_time() {
    let f = Fixture::new("repetition-time");
    let stem = "sub-01/func/sub-01_task-motor_bold";
    fs::create_dir_all(f.path("sub-01/func")).unwrap();
    fs::write(f.path(&format!("{stem}.nii")), bold()).unwrap();
    for value in [
        "0", "-2", "\"2\"", "\"NaN\"", "\"inf\"", "null", "true", "[]",
    ] {
        fs::write(
            f.path(&format!("{stem}.json")),
            format!(r#"{{"TaskName":"motor","RepetitionTime":{value}}}"#),
        )
        .unwrap();
        let result = block_on(bids::discover(&f.host(), &f.path(""), &[]));
        let error = result
            .err()
            .unwrap_or_else(|| panic!("accepted RepetitionTime {value}"));
        assert_eq!(
            error,
            "sub-01_task-motor_bold.nii: RepetitionTime must be a positive finite number"
        );
    }
    for value in ["2", "2.2"] {
        fs::write(
            f.path(&format!("{stem}.json")),
            format!(r#"{{"TaskName":"motor","RepetitionTime":{value}}}"#),
        )
        .unwrap();
        let subjects = block_on(bids::discover(&f.host(), &f.path(""), &[])).unwrap();
        assert_eq!(
            subjects[0].func[0].f64("RepetitionTime"),
            value.parse().ok()
        );
    }
}

#[test]
fn glm_resume_tracks_bold_sidecar() {
    let glm = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../glm");
    let target = glm.join("target");
    assert!(
        Command::new(env!("CARGO"))
            .arg("build")
            .arg("--manifest-path")
            .arg(glm.join("Cargo.toml"))
            .arg("--target-dir")
            .arg(&target)
            .args(["--bin", "glm"])
            .status()
            .unwrap()
            .success()
    );
    let f = Fixture::new("glm-resume");
    fs::write(f.path("bold.nii"), bold()).unwrap();
    fs::write(
        f.path("bold.json"),
        r#"{"RepetitionTime":2.2,"StartTime":0.6}"#,
    )
    .unwrap();
    let mut conf = "trans_x\ttrans_y\ttrans_z\trot_x\trot_y\trot_z\n".to_string();
    for t in 0..120 {
        let row: Vec<_> = (0..6)
            .map(|j| ((t as f64 * (j + 1) as f64 * 0.37).sin() * 0.04).to_string())
            .collect();
        conf += &(row.join("\t") + "\n");
    }
    fs::write(f.path("conf.tsv"), conf).unwrap();
    let mut events = "onset\tduration\ttrial_type\n".to_string();
    for (i, t) in (5..240).step_by(24).enumerate() {
        events += &format!("{t}\t12\t{}\n", if i % 2 == 0 { "left" } else { "right" });
    }
    fs::write(f.path("events.tsv"), events).unwrap();
    let outs: Vec<_> = (0..4)
        .map(|i| f.path(&format!("map{i}.nii")))
        .chain([f.path("summary.json")])
        .collect();
    let argv = fastprep_core::argv![
        target.join("debug/glm").to_str().unwrap(),
        "--task-analysis",
        f.path("bold.nii"),
        f.path("conf.tsv"),
        f.path("events.tsv"),
        ..outs[..4].iter(),
        "--summary",
        outs[4]
    ];
    block_on(async {
        let ctx = Ctx::new(
            f.host(),
            f.path("out"),
            f.path("work"),
            Templates::new("unused"),
            1,
            1,
            0,
        )
        .await;
        ctx.h.mkdirs(&ctx.work).unwrap();
        assert!(ctx.run(argv.clone(), &outs, None, None).await.unwrap());
        let first = fs::read(&outs[0]).unwrap();
        assert!(!ctx.run(argv.clone(), &outs, None, None).await.unwrap());
        let sidecar = File::options()
            .write(true)
            .open(f.path("bold.json"))
            .unwrap();
        let changed = sidecar.metadata().unwrap().modified().unwrap() + Duration::from_secs(1);
        fs::write(
            f.path("bold.json"),
            r#"{"RepetitionTime":2.2,"StartTime":1.6}"#,
        )
        .unwrap();
        sidecar.set_modified(changed).unwrap();
        assert!(
            ctx.run(argv.clone(), &outs, None, None).await.unwrap(),
            "GLM skipped after StartTime changed"
        );
        let resumed: Vec<_> = outs.iter().map(|p| fs::read(p).unwrap()).collect();
        assert_ne!(first, resumed[0], "StartTime must change the t map");
        fs::remove_dir_all(f.path("work/steps")).unwrap();
        assert!(ctx.run(argv.clone(), &outs, None, None).await.unwrap());
        assert_eq!(
            resumed,
            outs.iter()
                .map(|p| fs::read(p).unwrap())
                .collect::<Vec<_>>()
        );
        assert!(!ctx.run(argv, &outs, None, None).await.unwrap());
    });
}

#[test]
fn pepolar_solver_resolves_from_fastprep_home_bin_and_receives_argv() {
    use std::os::unix::fs::PermissionsExt;
    let fixture = Fixture::new("pepolar-tool");
    let bin = fixture.0.join("bin");
    fs::create_dir_all(&bin).unwrap();
    let solver = bin.join("sdc");
    fs::write(&solver, "#!/bin/sh\nprintf '%s\\n' \"$@\"\n").unwrap();
    fs::set_permissions(&solver, fs::Permissions::from_mode(0o755)).unwrap();
    let mut host = fixture.host();
    host.bin = bin;
    let step = Step {
        argv: [
            "sdc", "pyhysco", "a.nii.gz", "b.nii.gz", "pair", "--pe1", "j-", "--pe2", "j", "--trt",
            "0.04",
        ]
        .map(String::from)
        .to_vec(),
        fsl_out: None,
        gpu: false,
    };
    let result = block_on(host.run(&step)).unwrap();
    assert_eq!(result.code, 0);
    assert_eq!(result.stdout.lines().collect::<Vec<_>>(), step.argv[1..]);
}
