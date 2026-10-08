//! Voxel geometry from real files, compared with the NIfTI-MRS sform that
//! spec2nii 0.8.15 writes for the same file. Osprey's MIT example data
//! (github.com/schorschinho/osprey at 98b2e354, `exampledata/`) under
//! $OSPREY_EXAMPLES; the tests skip when it is absent.
use fida::io::detect::{load_all, LoadOptions, NamedFile};
use fida::io::geometry::Voxel;

fn osprey(rel: &str) -> Option<Vec<u8>> {
    let root = std::env::var("OSPREY_EXAMPLES").ok()?;
    std::fs::read(format!("{root}/{rel}")).ok()
}

fn voxel_of(files: &[(&str, Vec<u8>)]) -> Voxel {
    let named: Vec<NamedFile> = files.iter().map(|(n, b)| NamedFile { name: n, bytes: b }).collect();
    let (det, loaded) = load_all(&named, &LoadOptions::default());
    assert_eq!(det.pairs.len(), 1, "{det:?}");
    let (metab, _) = loaded.into_iter().next().unwrap();
    metab.unwrap().voxel.expect("voxel geometry")
}

fn close(v: &Voxel, want: [[f64; 4]; 3], tol: f64) {
    for r in 0..3 {
        for c in 0..4 {
            assert!((v.affine[r][c] - want[r][c]).abs() < tol, "row {r} col {c}: {:?} vs {want:?}", v.affine);
        }
    }
}

#[test]
fn philips_press_voxel() {
    let dir = "sdat/UnEdited/sub-01/ses-01/mrs/sub-01_ses-01_press";
    let (Some(sdat), Some(spar)) = (osprey(&format!("{dir}/sub-01_PRESS_35_act.sdat")), osprey(&format!("{dir}/sub-01_PRESS_35_act.spar"))) else {
        eprintln!("skipping: Osprey example data not found ($OSPREY_EXAMPLES)");
        return;
    };
    let v = voxel_of(&[("sub-01_PRESS_35_act.sdat", sdat), ("sub-01_PRESS_35_act.spar", spar)]);
    // spec2nii philips: sform of the NIfTI-MRS file.
    close(&v, [[30.0, 0.0, 0.0, 0.0], [0.0, 29.913668, -2.274303, -45.033447], [0.0, 2.274303, 29.913668, 37.662209]], 1e-5);
}

#[test]
fn siemens_twix_press_voxel() {
    let Some(dat) = osprey("twix/UnEdited/sub-01/ses-01/mrs/sub-01_ses-01_press/sub-01_PRESS30.dat") else {
        eprintln!("skipping: Osprey example data not found ($OSPREY_EXAMPLES)");
        return;
    };
    let v = voxel_of(&[("sub-01_PRESS30.dat", dat)]);
    // spec2nii twix -e image: sform of the NIfTI-MRS file.
    close(
        &v,
        [
            [29.999996, 0.000318, -0.016325, -4.395912],
            [-0.000318, -29.977212, -1.169079, 8.7819],
            [-0.016325, 1.169079, -29.977208, 58.784504],
        ],
        1e-5,
    );
}

#[test]
fn nifti_mrs_voxel_is_the_file_sform() {
    let Some(nii) = osprey("nifti-mrs/sub-01/ses-01/mrs/sub-01_ses-01_SVS-ref.nii.gz") else {
        eprintln!("skipping: Osprey example data not found ($OSPREY_EXAMPLES)");
        return;
    };
    let v = voxel_of(&[("sub-01_ses-01_SVS-ref.nii.gz", nii)]);
    close(&v, [[20.0, 0.0, 0.0, -32.900678], [0.0, -20.0, 0.0, 10.663376], [0.0, 0.0, -20.0, 21.35589]], 1e-4);
}
