#![allow(dead_code)]
#[path = "../../../exes/synthseg/src/nifti.rs"]
mod nifti;
mod support;
#[path = "../../../exes/synthseg/src/volume.rs"]
mod volume;
use support::*;

#[test]
fn scalar_endian_matrix_pins_storage_bits() {
    for (code, values) in scalar_cases() {
        for le in [false, true] {
            let f = Fixture::new(code, le, &values);
            let v = nifti::read(&f.bytes).unwrap();
            assert_eq!(v.dims, [2; 3]);
            let expected: Vec<u64> = values
                .iter()
                .map(|&x| {
                    let decoded = if code == 16 { (x as f32) as f64 } else { x };
                    (decoded * 1.0 + 0.0).to_bits()
                })
                .collect();
            assert_eq!(
                v.data.iter().map(|x| x.to_bits()).collect::<Vec<_>>(),
                expected,
                "code={code} le={le}"
            );
        }
    }
}

#[test]
fn acceptance_and_error_precedence() {
    let mut f = base();
    assert_eq!(
        nifti::read(&f.gzip()).unwrap().data,
        nifti::read(&f.bytes).unwrap().data
    );
    f.i16(42, 1);
    f.i16(70, -99);
    assert_eq!(nifti::read(&f.bytes).err().unwrap(), DIM);
    let mut f = base();
    f.i16(70, -99);
    f.f32(108, -1.);
    assert_eq!(nifti::read(&f.bytes).err().unwrap(), TYPE);
    let mut f = base();
    f.bytes.pop();
    assert_eq!(nifti::read(&f.bytes).err().unwrap(), TRUNC);
    let mut f = base();
    f.bytes.truncate(348);
    assert_eq!(nifti::read(&f.bytes).err().unwrap(), CHOOSE);
    let mut f = base();
    f.bytes[347] = 255;
    f.i16(72, -1);
    f.bytes.extend_from_slice(&[9; 8]);
    assert_eq!(nifti::read(&f.bytes).unwrap().data[0], 1.);
}

#[test]
fn scaling_offset_and_geometry_policy() {
    let mut f = base();
    f.f32(112, -2.);
    f.f32(116, 3.);
    assert_eq!(
        nifti::read(&f.bytes).unwrap().data,
        vec![1., -1., -3., -5., -7., -9., -11., -13.]
    );
    for slope in [0., -0.] {
        let mut f = base();
        f.f32(112, slope);
        f.f32(116, f32::NAN);
        assert_eq!(nifti::read(&f.bytes).unwrap().data[0], 1.);
    }
    let mut f = base();
    f.f32(108, 352.75);
    assert_eq!(nifti::read(&f.bytes).unwrap().data[0], 1.);
    let v = nifti::read(&base().bytes).unwrap();
    assert_eq!(
        v.affine,
        [[-1., 0., 0., 0.5], [0., 1., 0., -0.5], [0., 0., 1., -0.5]]
    );
    let mut f = base();
    f.f32(80, 0.);
    assert_eq!(
        nifti::read(&f.bytes).err().unwrap(),
        "The image affine is singular."
    );
    let mut f = base();
    f.f32(80, f32::NAN);
    assert_eq!(
        nifti::read(&f.bytes).err().unwrap(),
        "Invalid NIfTI affine."
    );
    let mut f = Fixture::new(2, true, &[2.; 16]);
    f.i16(40, 4);
    f.i16(48, 2);
    assert_eq!(nifti::read(&f.bytes).unwrap().data, vec![2.; 8]);
}

#[test]
fn fixture_snapshot_uses_real_readers_and_writer() {
    let mut cases = mutations();
    for (code, values) in scalar_cases() {
        for le in [false, true] {
            cases.push((
                format!("scalar-{code}-{le}"),
                Fixture::new(code, le, &values),
            ));
        }
    }
    let mut lines = Vec::new();
    for (name, f) in cases {
        let result = std::panic::catch_unwind(|| nifti::read(&f.bytes));
        let line = match result {
            Err(_) => "panic".to_string(),
            Ok(Err(e)) => format!("error={e}"),
            Ok(Ok(v)) => format!(
                "dims={:?} data={:?} affine={:?}{}",
                v.dims,
                v.data.iter().map(|x| x.to_bits()).collect::<Vec<_>>(),
                v.affine.map(|r| r.map(f64::to_bits)),
                format!(
                    " pixdim={:?} codes={:?} units={}",
                    v.pixdim.map(f64::to_bits),
                    v.codes,
                    v.units
                )
            ),
        };
        lines.push(format!("{name} {line}"));
    }
    let v = nifti::read(&base().bytes).unwrap();
    let out = nifti::Volume {
        data: vec![0, 1, -1, 2, i32::MIN, i32::MAX, 42, 9],
        dims: v.dims,
        affine: v.affine,
        pixdim: v.pixdim,
        codes: v.codes,
        units: v.units,
    };
    let bytes = nifti::write(&out);
    assert_eq!(&bytes[344..348], b"n+1\0");
    assert_eq!(bytes.len(), 384);
    lines.push(format!(
        "writer={}",
        bytes.iter().map(|b| format!("{b:02x}")).collect::<String>()
    ));
    snapshot("synthseg", lines);
}

#[test]
fn qform_priority_units_and_nonfinite_scaling() {
    let mut f = base();
    f.i16(252, 2);
    f.i16(254, 1);
    f.f32(76, -2.);
    for r in 0..3 {
        f.f32(280 + r * 16 + r * 4, 3.);
    }
    let v = nifti::read(&f.bytes).unwrap();
    assert_eq!(v.affine[2][2], 3.);
    for (units, _scale) in [(1, 1000.), (2, 1.), (3, 0.001), (9, 1000.)] {
        let mut f = base();
        f.bytes[123] = units;
        assert_eq!(nifti::read(&f.bytes).unwrap().affine[1][1], 1.);
    }
    let mut f = base();
    f.f32(112, f32::NAN);
    assert_eq!(nifti::read(&f.bytes).unwrap().data[0], 1.);
}

#[test]
fn malformed_endian_and_precision_policy() {
    let mut f = Fixture::new(2, false, &[7.; 8]);
    f.bytes[..4].copy_from_slice(&[1, 2, 3, 4]);
    assert_eq!(nifti::read(&f.bytes).unwrap().data, vec![7.; 8]);
    let f = Fixture::new(64, true, &[f64::MAX; 8]);
    assert_eq!(
        nifti::read(&f.bytes).unwrap().data[0].to_bits(),
        f64::MAX.to_bits()
    );
    let f = mutations()
        .into_iter()
        .find(|(name, _)| name == "channel-order")
        .unwrap()
        .1;
    assert_eq!(
        nifti::read(&f.bytes).unwrap().data[0].to_bits(),
        0.5f64.to_bits()
    );
}

#[test]
fn finite_channels_can_overflow_the_accumulated_image() {
    for le in [true, false] {
        let mut f = Fixture::new(64, le, &[f64::MAX; 24]);
        f.i16(40, 4);
        f.i16(48, 3);
        let image = nifti::read(&f.bytes).unwrap();
        assert_eq!(image.data.len(), 8);
        assert!(image.data.iter().all(|v| *v == f64::INFINITY));
    }
}
