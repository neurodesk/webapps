//! The GP DWI model on a small synthetic series: the b0 split and median, the data mask, the
//! leave-one-out fit and prediction, and the clip of the float64 prediction. This test always
//! runs; `gp_reference.rs` compares the model with NiFreeze's own output on ds005577.

use dwi_gradients::B0Rule;
use dwi_hmc::clip::InputKind;
use dwi_hmc::gp_model::{
    DTI_MIN_ORIENTATIONS, DwiSeries, GpModel, ModelError, clip_prediction, data_mask,
    read_gradients,
};

const SHAPE: [usize; 3] = [7, 6, 5];
const NVOX: usize = 7 * 6 * 5;

/// Two b0 volumes, then `n` directions on two shells (b = 1000 and 3000), FSL text.
fn table(n: usize) -> (String, String) {
    let mut bvals = vec!["0".to_string(), "5".to_string()];
    let mut rows = [vec![0.0f64; 2], vec![0.0; 2], vec![0.0; 2]];
    for i in 0..n {
        let z = -0.9 + 1.8 * (i as f64) / (n as f64 - 1.0);
        let p = 2.399963 * i as f64;
        let r = (1.0 - z * z).sqrt();
        let g = [r * p.cos(), r * p.sin(), z];
        bvals.push(if i % 3 == 0 { "1000" } else { "3000" }.to_string());
        for k in 0..3 {
            rows[k].push(g[k]);
        }
    }
    let bvec = rows
        .iter()
        .map(|r| {
            r.iter()
                .map(|v| format!("{v:.9}"))
                .collect::<Vec<_>>()
                .join(" ")
        })
        .collect::<Vec<_>>()
        .join("\n");
    (bvals.join(" "), bvec)
}

fn voxel(x: usize, y: usize, z: usize) -> usize {
    x + SHAPE[0] * (y + SHAPE[1] * z)
}

/// A series with an anisotropic signal. Voxel (0, 0, 0) is 0 in both b0 volumes; voxel
/// (1, 0, 0) has 1 in one b0 and 0 in the other (median 0.5, kept); voxel (2, 0, 0) has the
/// value 700 in every volume.
fn series(n: usize) -> (Vec<i16>, B0Rule, String, String) {
    let (bval, bvec) = table(n);
    let (bvals, bvecs) = read_gradients(&bval, &bvec).unwrap();
    let mut data = vec![0i16; NVOX * (n + 2)];
    for v in 0..n + 2 {
        for i in 0..NVOX {
            let s0 = 400.0 + 9.0 * (i % 37) as f64;
            let d = 0.0004 + 0.00002 * (i % 23) as f64;
            let g = bvecs[v];
            let fa = 0.6 * g[0] * g[0] + 0.2 * g[1] * g[1];
            let s = s0 * (-bvals[v] * d * (1.0 + fa)).exp();
            data[v * NVOX + i] = s.round() as i16;
        }
    }
    data[voxel(0, 0, 0)] = 0;
    data[NVOX + voxel(0, 0, 0)] = 0;
    data[voxel(1, 0, 0)] = 1;
    data[NVOX + voxel(1, 0, 0)] = 0;
    for v in 0..n + 2 {
        data[v * NVOX + voxel(2, 0, 0)] = 700;
    }
    (data, B0Rule::NiFreeze, bval, bvec)
}

fn brainmask() -> Vec<bool> {
    // Everything except the slice z = 4.
    (0..NVOX).map(|i| i / (SHAPE[0] * SHAPE[1]) < 4).collect()
}

#[test]
fn split_takes_the_median_of_the_b0_volumes() {
    let (data, rule, bval, bvec) = series(8);
    let (bvals, bvecs) = read_gradients(&bval, &bvec).unwrap();
    let g = rule.read(bvals, bvecs).unwrap();
    let s = DwiSeries::split(&data, SHAPE, &g).unwrap();
    assert_eq!(s.b0_volumes, vec![0, 1]);
    assert_eq!(s.dwi_volumes, (2..10).collect::<Vec<_>>());
    assert_eq!(s.len(), 8);
    let bzero = s.bzero.as_ref().unwrap();
    assert_eq!(bzero[voxel(0, 0, 0)], 0.0);
    assert_eq!(bzero[voxel(1, 0, 0)], 0.5);
    assert_eq!(bzero[voxel(2, 0, 0)], 700.0);
    // The diffusion-weighted volumes keep their order.
    assert_eq!(&s.dwi[..NVOX], &data[2 * NVOX..3 * NVOX]);
    assert_eq!(s.bvecs[0], g.bvecs[2]);
}

fn one_voxel_series(b0: &[f64]) -> DwiSeries<f64> {
    let (bval, bvec) = table(DTI_MIN_ORIENTATIONS);
    let (bvals, bvecs) = read_gradients(&bval, &bvec).unwrap();
    let gradients = B0Rule::NiFreeze
        .read(
            [vec![0.0; b0.len()], bvals[2..].to_vec()].concat(),
            [vec![[0.0; 3]; b0.len()], bvecs[2..].to_vec()].concat(),
        )
        .unwrap();
    let mut data = b0.to_vec();
    data.extend([700.0; DTI_MIN_ORIENTATIONS]);
    DwiSeries::split(&data, [1, 1, 1], &gradients).unwrap()
}

#[test]
fn split_median_matches_numpy_for_non_finite_and_finite_b0_values() {
    let cases: &[(&[f64], f64)] = &[
        (&[7.0, 1.0, 3.0], 3.0),
        (&[7.0, 1.0, 5.0, 3.0], 4.0),
        (&[f64::NAN, 3.0, 7.0], f64::NAN),
        (&[1.0, 3.0, 7.0, f64::NAN], f64::NAN),
        (&[f64::NEG_INFINITY, 0.0, f64::INFINITY], 0.0),
        (&[f64::INFINITY, f64::INFINITY], f64::INFINITY),
        (&[f64::NEG_INFINITY, f64::INFINITY], f64::NAN),
        (&[-0.0, 0.0], 0.0),
        (&[-0.0, 0.0, -0.0], 0.0),
    ];
    for &(b0, expected) in cases {
        let series = one_voxel_series(b0);
        let median = series.bzero.unwrap()[0];
        if expected.is_nan() {
            assert!(median.is_nan(), "{b0:?}: {median}");
        } else {
            assert_eq!(median.to_bits(), expected.to_bits(), "{b0:?}");
        }
    }
}

#[test]
fn a_nan_b0_median_keeps_the_mask_and_finite_dwi_prediction() {
    for b0 in [&[f64::NAN, 3.0][..], &[1.0, 3.0, f64::NAN][..]] {
        let series = one_voxel_series(b0);
        assert!(series.bzero.as_ref().unwrap()[0].is_nan());
        assert!(series.dwi.iter().all(|v| v.is_finite()));
        let model = GpModel::new(&series, None).unwrap();
        assert_eq!(model.data_mask(), &[true]);
        assert_eq!(model.fit_predict(0).unwrap().volume, vec![700.0]);
        assert!(series.bzero.as_ref().unwrap()[0].is_nan());
    }
}

#[test]
fn data_mask_removes_voxels_where_bzero_is_below_1e_5() {
    let bzero = [0.0, 1e-5, 9.9e-6, 3.0, -1.0];
    let brain = [true, true, true, false, true];
    assert_eq!(
        data_mask(5, Some(&brain), Some(&bzero)),
        vec![false, true, false, false, false]
    );
    assert_eq!(data_mask(3, None, None), vec![true; 3]);
    assert_eq!(
        data_mask(5, None, Some(&bzero)),
        vec![false, true, false, true, false]
    );
}

#[test]
fn read_gradients_rounds_to_float32_and_accepts_both_layouts() {
    let (bvals, bvecs) = read_gradients("0 1000\n", "0 0.1\n0 0.2\n0 0.7\n").unwrap();
    assert_eq!(bvals, vec![0.0, 1000.0]);
    assert_eq!(bvecs[1], [0.1f32 as f64, 0.2f32 as f64, 0.7f32 as f64]);
    assert_ne!(bvecs[1][0], 0.1);
    let (_, rows) = read_gradients("0 1000", "0 0 0\n0.1 0.2 0.7\n").unwrap();
    assert_eq!(rows, bvecs);
    assert!(read_gradients("0 1000", "0 0.1\n0 0.2\n").is_err());
}

#[test]
fn fit_predict_leaves_one_out_and_clips_the_float_prediction() {
    let n = 8;
    let (data, rule, bval, bvec) = series(n);
    let (bvals, bvecs) = read_gradients(&bval, &bvec).unwrap();
    let g = rule.read(bvals, bvecs).unwrap();
    let s = DwiSeries::split(&data, SHAPE, &g).unwrap();
    let mask = brainmask();
    let model = GpModel::new(&s, Some(&mask)).unwrap();

    // The data mask is the brain mask minus voxel (0, 0, 0), whose b0 median is 0.
    let expected = data_mask(NVOX, Some(&mask), s.bzero.as_deref());
    assert_eq!(model.data_mask(), expected.as_slice());
    assert!(!model.data_mask()[voxel(0, 0, 0)]);
    assert!(model.data_mask()[voxel(1, 0, 0)]);
    assert_eq!(model.voxel_count(), 4 * SHAPE[0] * SHAPE[1] - 1);

    for index in 0..n {
        let fit = model.fit(index).unwrap();
        assert_eq!(fit.x_train.len(), n - 1);
        assert!(!fit.x_train.contains(&s.bvecs[index]));
        assert_eq!(fit.targets.t, model.voxel_count());

        let mut p = model.fit_predict(index).unwrap();
        assert_eq!(p.fit.theta, fit.theta);
        // 0 outside the data mask; a constant voxel predicts its value exactly.
        for (i, &v) in p.volume.iter().enumerate() {
            if !model.data_mask()[i] {
                assert_eq!(v, 0.0);
            }
        }
        assert_eq!(p.volume[voxel(2, 0, 0)], 700.0);
        // The targets are in NumPy's C order of the (x, y, z) array: z varies fastest, and
        // (0, 0, 0) is not in the data mask.
        let again = fit.predict(&[s.bvecs[index]]).unwrap();
        assert_eq!(again.len(), model.voxel_count());
        assert_eq!(again[0], p.volume[voxel(0, 0, 1)]);
        assert_eq!(again[3], p.volume[voxel(0, 1, 0)]);
        assert_eq!(again[4 * SHAPE[1] - 1], p.volume[voxel(1, 0, 0)]);

        let report = clip_prediction(&mut p.volume, SHAPE).unwrap();
        assert_eq!(report.input, InputKind::Float);
        assert!(report.mutated);
        assert!(
            p.volume
                .iter()
                .all(|&v| v == v.round() && (0.0..=255.0).contains(&v))
        );
        assert!(p.volume.contains(&255.0));
    }
}

#[test]
fn model_refuses_bad_input() {
    let n = DTI_MIN_ORIENTATIONS - 1;
    let (data, rule, bval, bvec) = series(n);
    let (bvals, bvecs) = read_gradients(&bval, &bvec).unwrap();
    let g = rule.read(bvals, bvecs).unwrap();
    let s = DwiSeries::split(&data, SHAPE, &g).unwrap();
    assert_eq!(
        GpModel::new(&s, None).unwrap_err(),
        ModelError::TooFewVolumes(n)
    );

    let (data, rule, bval, bvec) = series(DTI_MIN_ORIENTATIONS);
    let (bvals, bvecs) = read_gradients(&bval, &bvec).unwrap();
    let g = rule.read(bvals, bvecs).unwrap();
    assert!(matches!(
        DwiSeries::split(&data[1..], SHAPE, &g),
        Err(ModelError::Shape(_))
    ));
    let s = DwiSeries::split(&data, SHAPE, &g).unwrap();
    assert_eq!(
        GpModel::new(&s, Some(&[true; 3])).unwrap_err(),
        ModelError::Shape("the brain mask or bzero is not a [7, 6, 5] volume".into())
    );
    assert_eq!(
        GpModel::new(&s, Some(&vec![false; NVOX])).unwrap_err(),
        ModelError::EmptyMask
    );
    let model = GpModel::new(&s, None).unwrap();
    assert!(matches!(
        model.fit(DTI_MIN_ORIENTATIONS),
        Err(ModelError::Index { .. })
    ));
}

#[test]
fn model_refuses_zero_and_overflowing_dimensions() {
    let (data, rule, bval, bvec) = series(DTI_MIN_ORIENTATIONS);
    let (bvals, bvecs) = read_gradients(&bval, &bvec).unwrap();
    let gradients = rule.read(bvals, bvecs).unwrap();
    let mut series = DwiSeries::split(&data, SHAPE, &gradients).unwrap();
    series.dwi.clear();
    series.bzero = None;
    for shape in [
        [0, 1, 1],
        [usize::MAX, 2, 1],
        [usize::MAX, 1, 1],
        [1usize << (usize::BITS - 1), 1, 1],
    ] {
        series.shape = shape;
        assert!(matches!(
            GpModel::new(&series, None),
            Err(ModelError::Shape(_))
        ));
        assert!(series.dwi.is_empty());
    }
}
