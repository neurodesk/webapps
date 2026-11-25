//! The ordered tool commands (`commands.sh`) for each input case under both normalizations, through an in-memory
//! host whose stub tools write their declared outputs. The same cases run through the WebAssembly build
//! (`packages/syncro/test/core-argv.test.js`), which must produce these files byte for byte.
//! `UPDATE_GOLDENS=1 cargo test` rewrites them.

use neurodesk_pipeline_host::{Exit, Host, Stat, Step, block_on};
use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;
use syncro_core::pipeline::{Device, Normalization, Options, run};
use syncro_core::volume::{Volume, gzip, write};

#[derive(Default)]
struct Memory {
    files: RefCell<BTreeMap<String, Vec<u8>>>,
    clock: Cell<u128>,
}

fn template() -> Volume<f32> {
    let dims = [10, 10, 10];
    let data = (0..1000)
        .map(|i| {
            if (i % 10) > 1 && (i % 10) < 8 {
                50.0
            } else {
                0.0
            }
        })
        .collect();
    Volume {
        data,
        dims,
        affine: [
            [-1.0, 0.0, 0.0, 5.0],
            [0.0, 1.0, 0.0, -5.0],
            [0.0, 0.0, 1.0, -5.0],
        ],
    }
}

fn scan(affine: [[f64; 4]; 3], offset: f32) -> Volume<f32> {
    Volume {
        data: (0..512).map(|i| offset + i as f32).collect(),
        dims: [8, 8, 8],
        affine,
    }
}

const IDENTITY: [[f64; 4]; 3] = [
    [1.0, 0.0, 0.0, 0.0],
    [0.0, 1.0, 0.0, 0.0],
    [0.0, 0.0, 1.0, 0.0],
];
const TILTED: [[f64; 4]; 3] = [
    [-1.0, 0.0, 0.0, 5.0],
    [0.0, 1.0, 0.0, 0.0],
    [0.0, 0.15, 1.0, 0.0],
];

impl Memory {
    fn put(&self, path: &str, bytes: Vec<u8>) {
        self.clock.set(self.clock.get() + 1);
        self.files.borrow_mut().insert(path.to_string(), bytes);
    }
    fn image(&self, path: &str) {
        let bytes = write(&template(), "stub output");
        self.put(
            path,
            if path.ends_with(".gz") {
                gzip(&bytes)
            } else {
                bytes
            },
        );
    }
}

/// The value after `flag`.
fn after<'a>(argv: &'a [String], flag: &str) -> &'a str {
    &argv[argv.iter().position(|a| a == flag).unwrap() + 1]
}

impl Host for Memory {
    async fn run(&self, step: &Step) -> Result<Exit, String> {
        let a = &step.argv;
        match a[0].as_str() {
            "greedy-rs" if a.contains(&"-rm".to_string()) => {
                let at = a.iter().position(|x| x == "-rm").unwrap();
                self.image(&a[at + 2]);
            }
            "greedy-rs" if a.contains(&"-a".to_string()) => self.put(
                after(a, "-o"),
                b"1 0 0 0\n0 1 0 0\n0 0 1 0\n0 0 0 1\n".to_vec(),
            ),
            "greedy-rs" => self.image(after(a, "-o")),
            "synthsr" => self.image(&a[2]),
            "brainchop-mindgrab" => {
                self.image(after(a, "-o"));
                self.image(after(a, "--mask"));
            }
            "niimath" => self.image(&a[a.iter().position(|x| x == "-odt").unwrap() - 1]),
            "antsRegistration" => {
                let spec = after(a, "--output").trim_matches(['[', ']']);
                let (prefix, warped) = spec.split_once(',').unwrap();
                self.image(warped);
                self.image(&format!("{prefix}1Warp.nii.gz"));
                self.put(&format!("{prefix}0GenericAffine.mat"), b"affine".to_vec());
            }
            "antsApplyTransforms" => self.image(after(a, "-o")),
            tool => return Err(format!("unexpected tool {tool}")),
        }
        Ok(Exit {
            code: 0,
            stdout: String::new(),
            stderr: String::new(),
        })
    }
    async fn read_range(&self, path: &str, offset: u64, len: usize) -> Result<Vec<u8>, String> {
        let files = self.files.borrow();
        let b = files.get(path).ok_or_else(|| format!("{path}: missing"))?;
        let start = (offset as usize).min(b.len());
        Ok(b[start..(start + len).min(b.len())].to_vec())
    }
    async fn read_text(&self, path: &str, _limit: usize) -> Result<String, String> {
        Ok(String::from_utf8(self.read_range(path, 0, usize::MAX).await?).unwrap())
    }
    async fn write(&self, path: &str, bytes: &[u8]) -> Result<(), String> {
        self.put(path, bytes.to_vec());
        Ok(())
    }
    async fn append(&self, path: &str, bytes: &[u8]) -> Result<(), String> {
        let mut all = self.files.borrow().get(path).cloned().unwrap_or_default();
        all.extend_from_slice(bytes);
        self.put(path, all);
        Ok(())
    }
    fn exists(&self, path: &str) -> bool {
        self.files.borrow().contains_key(path)
    }
    fn stat(&self, path: &str) -> Option<Stat> {
        self.files.borrow().get(path).map(|b| (b.len() as u64, 0))
    }
    fn list(&self, _dir: &str) -> Vec<String> {
        vec![]
    }
    fn mkdirs(&self, _dir: &str) -> Result<(), String> {
        Ok(())
    }
    fn remove(&self, path: &str) {
        self.files.borrow_mut().remove(path);
    }
    fn rename(&self, from: &str, to: &str) -> Result<(), String> {
        let b = self.files.borrow_mut().remove(from).ok_or("missing")?;
        self.put(to, b);
        Ok(())
    }
    fn copy(&self, from: &str, to: &str) -> Result<(), String> {
        let b = self.files.borrow().get(from).cloned().ok_or("missing")?;
        self.put(to, b);
        Ok(())
    }
    fn now(&self) -> f64 {
        0.0
    }
    fn local_time(&self) -> String {
        String::new()
    }
    fn log(&self, _line: &str) {}
}

struct Case {
    name: &'static str,
    primary: Volume<f32>,
    pathological: Option<Volume<f32>>,
    lesion: bool,
    ct: bool,
}

fn cases() -> Vec<Case> {
    vec![
        Case {
            name: "t1",
            primary: scan(IDENTITY, 10.0),
            pathological: None,
            lesion: false,
            ct: false,
        },
        // A gantry-tilted CT: de-sheared, and filled with min(0, darkest) when resliced.
        Case {
            name: "ct",
            primary: scan(TILTED, -1024.0),
            pathological: None,
            lesion: false,
            ct: true,
        },
        Case {
            name: "t1-lesion",
            primary: scan(IDENTITY, 10.0),
            pathological: None,
            lesion: true,
            ct: false,
        },
        Case {
            name: "t1-pathological-lesion",
            primary: scan(IDENTITY, 10.0),
            pathological: Some(scan(IDENTITY, 3.0)),
            lesion: true,
            ct: false,
        },
    ]
}

/// The commands a case runs, as commands.sh records them.
fn commands(case: &Case, normalization: Normalization) -> String {
    let h = Memory::default();
    h.put(
        "/in/sub-01_T1w.nii.gz",
        gzip(&write(&case.primary, "primary")),
    );
    h.put("/in/mni.nii.gz", gzip(&write(&template(), "template")));
    let mut o = Options {
        input: "/in/sub-01_T1w.nii.gz".into(),
        lesion: None,
        pathological: None,
        template: "/in/mni.nii.gz".into(),
        out: String::new(),
        work: "work".into(),
        ct: case.ct,
        normalization,
        threads: 4,
        device: Device::Auto,
        keep_synth: false,
        heal: false,
        software: serde_json::Value::Null,
    };
    if let Some(p) = &case.pathological {
        h.put("/in/sub-01_FLAIR.nii", write(p, "pathological"));
        o.pathological = Some("/in/sub-01_FLAIR.nii".into());
    }
    if case.lesion {
        let reference = case.pathological.as_ref().unwrap_or(&case.primary);
        let data = (0..512).map(|i| u8::from(i == 300) * 255).collect();
        h.put(
            "/in/lesion.nii",
            write(
                &Volume {
                    data,
                    dims: [8, 8, 8],
                    affine: reference.affine,
                },
                "lesion",
            ),
        );
        o.lesion = Some("/in/lesion.nii".into());
    }
    let provenance = block_on(run(&h, &o, &|_| {})).unwrap();
    assert_eq!(provenance["desheared"]["primary"], case.ct);
    String::from_utf8(h.files.borrow()["work/commands.sh"].clone()).unwrap()
}

#[test]
fn commands_match_the_goldens() {
    let update = std::env::var_os("UPDATE_GOLDENS").is_some();
    for case in cases() {
        for (normalization, suffix) in [
            (Normalization::Greedy, "greedy"),
            (Normalization::Ants, "ants"),
        ] {
            let path = format!(
                "{}/tests/goldens/{}-{suffix}.sh",
                env!("CARGO_MANIFEST_DIR"),
                case.name
            );
            let got = commands(&case, normalization);
            if update {
                std::fs::write(&path, &got).unwrap();
            } else {
                assert_eq!(got, std::fs::read_to_string(&path).unwrap(), "{path}");
            }
        }
    }
}

/// Refusals from packages/syncro/test/geometry.test.js: each stops before any tool runs.
#[test]
fn bad_inputs_are_refused_before_any_tool() {
    let attempt =
        |primary: Vec<u8>, lesion: Option<Vec<u8>>, pathological: Option<(&str, Vec<u8>)>| {
            let h = Memory::default();
            h.put("/in/primary.nii", primary);
            h.put("/in/mni.nii", write(&template(), "template"));
            let mut o = Options {
                input: "/in/primary.nii".into(),
                lesion: None,
                pathological: None,
                template: "/in/mni.nii".into(),
                out: String::new(),
                work: "work".into(),
                ct: false,
                normalization: Normalization::Greedy,
                threads: 1,
                device: Device::Auto,
                keep_synth: false,
                heal: false,
                software: serde_json::Value::Null,
            };
            if let Some(l) = lesion {
                h.put("/in/lesion.nii", l);
                o.lesion = Some("/in/lesion.nii".into());
            }
            if let Some((name, p)) = pathological {
                let path = format!("/in/{name}");
                h.put(&path, p);
                o.pathological = Some(path);
            }
            let error = block_on(run(&h, &o, &|_| {})).unwrap_err();
            assert!(!h.exists("work/commands.sh"), "{error}: a tool ran");
            error
        };
    let source = write(&scan(IDENTITY, 10.0), "scan");
    let mask = |affine| {
        write(
            &Volume {
                data: (0..512).map(|i| u8::from(i == 62) * 255).collect(),
                dims: [8, 8, 8],
                affine,
            },
            "mask",
        )
    };
    assert!(attempt(mask(IDENTITY), None, None).contains("primary scan must be a scalar image"));
    assert!(
        attempt(source.clone(), None, Some(("trace.nii", mask(IDENTITY))))
            .contains("pathological modality scan must be a scalar image")
    );
    assert!(
        attempt(
            source.clone(),
            None,
            Some(("bt1primary.nii", source.clone()))
        )
        .contains("duplicate output names")
    );
    let mut moved = IDENTITY;
    moved[0][3] = 2.0;
    assert!(
        attempt(source.clone(), Some(mask(moved)), None)
            .contains("must match the primary scan grid")
    );
    let three = write(
        &Volume {
            data: (0..512).map(|i| (i % 3) as f32).collect(),
            dims: [8, 8, 8],
            affine: IDENTITY,
        },
        "three levels",
    );
    assert!(attempt(source, Some(three), None).contains("no more than two discrete values"));
}
