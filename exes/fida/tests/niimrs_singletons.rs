use fida::io::niimrs;
use num_complex::Complex64;
use serde_json::json;

fn fixture(shape: [i16; 3], tags: [&str; 3]) -> Vec<u8> {
    let json = serde_json::to_vec(&json!({
        "SpectrometerFrequency": [123.25], "ResonantNucleus": ["1H"],
        "EchoTime": 0.03, "RepetitionTime": 2.0,
        "dim_5": tags[0], "dim_6": tags[1], "dim_7": tags[2],
    })).unwrap();
    let esize = (json.len() + 8 + 15) / 16 * 16;
    let offset = 352 + esize;
    let count = 4 * shape.iter().map(|&v| v as usize).product::<usize>();
    let mut bytes = vec![0u8; offset + count * 8];
    bytes[0..4].copy_from_slice(&348i32.to_le_bytes());
    for (k, d) in [7, 1, 1, 1, 4, shape[0], shape[1], shape[2]].iter().enumerate() {
        bytes[40 + k * 2..42 + k * 2].copy_from_slice(&i16::to_le_bytes(*d));
    }
    bytes[70..72].copy_from_slice(&32i16.to_le_bytes());
    bytes[92..96].copy_from_slice(&0.0005f32.to_le_bytes());
    bytes[108..112].copy_from_slice(&(offset as f32).to_le_bytes());
    bytes[344..348].copy_from_slice(b"n+1\0");
    bytes[348] = 1;
    bytes[352..356].copy_from_slice(&(esize as i32).to_le_bytes());
    bytes[356..360].copy_from_slice(&44i32.to_le_bytes());
    bytes[360..360 + json.len()].copy_from_slice(&json);
    for i in 0..count {
        bytes[offset + i * 8..offset + i * 8 + 4].copy_from_slice(&(i as f32).to_le_bytes());
        bytes[offset + i * 8 + 4..offset + i * 8 + 8].copy_from_slice(&((i + 1) as f32).to_le_bytes());
    }
    bytes
}

#[test]
fn singleton_coil_before_dynamics_preserves_transients() {
    let s = niimrs::load(&fixture([1, 3, 1], ["DIM_COIL", "DIM_DYN", "DIM_EDIT"])).unwrap();
    assert_eq!(s.dims.coils, 0);
    assert_eq!(s.dims.averages, 2);
    assert_eq!(s.dims.sub_specs, 0);
    assert_eq!(s.sz, vec![4, 3]);
    assert!(s.flags.addedrcvrs);
    assert!(!s.flags.averaged);
    for i in 0..12 {
        assert_eq!(s.fids[i], Complex64::new(i as f64, -((i + 1) as f64)));
    }
    assert_eq!(s.te, 0.03);
    assert_eq!(s.tr, 2.0);
}

#[test]
fn singleton_dynamics_preserves_and_reorders_edit_and_coil_axes() {
    let s = niimrs::load(&fixture([1, 2, 3], ["DIM_DYN", "DIM_EDIT", "DIM_COIL"])).unwrap();
    assert_eq!(s.dims.coils, 2);
    assert_eq!(s.dims.averages, 0);
    assert_eq!(s.dims.sub_specs, 3);
    assert_eq!(s.sz, vec![4, 3, 2]);
    assert!(s.flags.averaged);
    for edit in 0..2 {
        for coil in 0..3 {
            for point in 0..4 {
                let src = point + 4 * (edit + 2 * coil);
                let dst = point + 4 * (coil + 3 * edit);
                assert_eq!(s.fids[dst], Complex64::new(src as f64, -((src + 1) as f64)));
            }
        }
    }
}
