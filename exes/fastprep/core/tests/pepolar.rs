use fastprep_core::bids::{Image, parse_name};
use fastprep_core::host::{Exit, Host, Stat, Step};
use fastprep_core::nifti::Header;
use fastprep_core::run::{Ctx, Templates};
use fastprep_core::{block_on, stages};
use serde_json::json;
use std::cell::RefCell;
use std::rc::Rc;

struct Recorder(Rc<RefCell<Vec<Vec<String>>>>);
impl Host for Recorder {
    async fn run(&self, step: &Step) -> Result<Exit, String> {
        self.0.borrow_mut().push(step.argv.clone());
        Ok(Exit {
            code: 0,
            stdout: String::new(),
            stderr: String::new(),
        })
    }
    async fn read_range(&self, _: &str, _: u64, _: usize) -> Result<Vec<u8>, String> {
        Err("not used".into())
    }
    async fn read_text(&self, _: &str, _: usize) -> Result<String, String> {
        Err("no cached records".into())
    }
    async fn write(&self, _: &str, _: &[u8]) -> Result<(), String> {
        Ok(())
    }
    async fn append(&self, _: &str, _: &[u8]) -> Result<(), String> {
        Ok(())
    }
    fn exists(&self, _: &str) -> bool {
        true
    }
    fn stat(&self, _: &str) -> Option<Stat> {
        Some((1, 1))
    }
    fn list(&self, _: &str) -> Vec<String> {
        vec![]
    }
    fn mkdirs(&self, _: &str) -> Result<(), String> {
        Ok(())
    }
    fn remove(&self, _: &str) {}
    fn rename(&self, _: &str, _: &str) -> Result<(), String> {
        Ok(())
    }
    fn copy(&self, _: &str, _: &str) -> Result<(), String> {
        Ok(())
    }
    fn now(&self) -> f64 {
        0.0
    }
    fn local_time(&self) -> String {
        String::new()
    }
    fn log(&self, _: &str) {}
}

fn image(name: &str, meta: serde_json::Value) -> Image {
    let (ents, suffix) = parse_name(name).unwrap();
    Image {
        path: format!("/bids/sub-x/fmap/{name}"),
        rel: format!("sub-x/fmap/{name}"),
        ents,
        suffix,
        hdr: Rc::new(Header {
            shape: vec![8, 40, 4],
            zooms: vec![2.0; 3],
            affine: [
                [2.0, 0.0, 0.0, 0.0],
                [0.0, 2.0, 0.0, 0.0],
                [0.0, 0.0, 2.0, 0.0],
            ],
        }),
        meta: Rc::new(meta.as_object().unwrap().clone()),
        echoes: vec![],
        phases: vec![],
    }
}

#[test]
fn pepolar_commands_estimate_hz_and_use_corrected_reference_with_jacobian() {
    block_on(async {
        let calls = Rc::new(RefCell::new(vec![]));
        let c = Ctx::new(
            Recorder(calls.clone()),
            "/out".into(),
            "/work".into(),
            Templates::new("/tpl"),
            2,
            2,
            1,
        )
        .await;
        let images = [
            image(
                "sub-x_dir-AP_epi.nii.gz",
                json!({"PhaseEncodingDirection": "j-", "TotalReadoutTime": 0.04}),
            ),
            image(
                "sub-x_dir-PA_epi.nii.gz",
                json!({"PhaseEncodingDirection": "j", "TotalReadoutTime": 0.04}),
            ),
        ];
        let field = stages::fieldmap(&c, "pair", &images).await.unwrap();
        assert_eq!(field.method, "pyhysco");
        assert!(field.jacobian);
        let calls = calls.borrow();
        assert_eq!(calls.len(), 6);
        assert_eq!(&calls[0][..3], &["niimath", &images[0].path, "-Tmean"]);
        assert_eq!(&calls[1][..3], &["niimath", &images[1].path, "-Tmean"]);
        assert_eq!(calls[2][..2], ["sdc", "pyhysco"]);
        assert_eq!(
            calls[2][5..],
            ["--pe1", "j-", "--pe2", "j", "--trt", "0.04"]
        );
        assert_eq!(calls[3][2], field.hz);
        assert!(calls[4][1].ends_with("_corrected1.nii.gz"));
        assert!(calls[4][3].ends_with("_corrected2.nii.gz"));
        assert_eq!(&calls[4][4..6], &["-div", "2"]);
        assert_eq!(calls[5][2], field.reference);
        assert_eq!(calls[5].last(), calls[4].last());
    });
}

#[test]
fn phasediff_keeps_its_existing_unwrap_and_hz_commands() {
    block_on(async {
        let calls = Rc::new(RefCell::new(vec![]));
        let c = Ctx::new(
            Recorder(calls.clone()),
            "/out".into(),
            "/work".into(),
            Templates::new("/tpl"),
            2,
            2,
            1,
        )
        .await;
        let images = [
            image(
                "sub-x_phasediff.nii.gz",
                json!({"EchoTime1": 0.00492, "EchoTime2": 0.00738}),
            ),
            image("sub-x_magnitude1.nii.gz", json!({"EchoTime": 0.00492})),
        ];
        let field = stages::fieldmap(&c, "pair", &images).await.unwrap();
        assert_eq!(field.method, "phasediff");
        assert!(!field.jacobian);
        let calls = calls.borrow();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].last(), Some(&images[1].path));
        assert_eq!(
            calls[1][..5],
            ["niimath", &images[0].path, "-p", "2", "-fmapprep"]
        );
        assert_eq!(calls[1][5], field.reference);
        assert_eq!(
            calls[1][7..12],
            ["-dilall", "-s", "3", "-div", "6.283185307179586"]
        );
        assert_eq!(calls[1].last(), Some(&field.hz));
    });
}

#[test]
fn pepolar_field_uses_bold_readout_and_polarity_in_registered_voxel_shifts() {
    for (pe, expected) in [("j", "0.08"), ("j-", "-0.08")] {
        block_on(async {
            let calls = Rc::new(RefCell::new(vec![]));
            let c = Ctx::new(
                Recorder(calls.clone()),
                "/out".into(),
                "/work".into(),
                Templates::new("/tpl"),
                2,
                2,
                1,
            )
            .await;
            let field = Rc::new(stages::Fmap {
                hz: "/field-hz.nii.gz".into(),
                reference: "/corrected-reference.nii.gz".into(),
                jacobian: true,
                kind: "pepolar".into(),
                method: "pyhysco",
                dte_ms: 0.0,
            });
            let bold = image(
                "sub-x_task-rest_bold.nii.gz",
                json!({"PhaseEncodingDirection": pe, "TotalReadoutTime": 0.08}),
            );
            stages::bold_fit(&c, &bold, None, Some(field), None, "off", "off")
                .await
                .unwrap();
            let calls = calls.borrow();
            let conversion = calls
                .iter()
                .find(|argv| argv[1] == "/field-hz.nii.gz")
                .unwrap();
            let multiply = conversion.iter().position(|arg| arg == "-mul").unwrap();
            assert_eq!(conversion[multiply + 1], expected);
            assert!(conversion.iter().any(|arg| arg == "-resample"));
            assert!(conversion.iter().any(|arg| arg == "-mat"));
            let application = calls
                .iter()
                .find(|argv| argv.iter().any(|arg| arg == "-vsm"))
                .unwrap();
            let shift = application.iter().position(|arg| arg == "-vsm").unwrap();
            assert_eq!(&application[shift + 2..shift + 4], &["j", "-jacobian"]);
            assert!(!calls.iter().flatten().any(|arg| arg == "-fmapprep"));
        });
    }
}
