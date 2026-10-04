#![allow(dead_code)]
use std::io::Write;

#[derive(Clone)]
pub struct Fixture {
    pub bytes: Vec<u8>,
    pub le: bool,
}
impl Fixture {
    pub fn new(code: i16, le: bool, values: &[f64]) -> Self {
        let mut f = Self {
            bytes: vec![0; 352],
            le,
        };
        let header = if le {
            348i32.to_le_bytes()
        } else {
            348i32.to_be_bytes()
        };
        f.bytes[..4].copy_from_slice(&header);
        f.i16(40, 3);
        for a in 1..8 {
            f.i16(40 + a * 2, if a < 4 { 2 } else { 1 });
        }
        f.i16(70, code);
        f.i16(72, 8);
        for a in 0..4 {
            f.f32(76 + a * 4, 1.0);
        }
        f.f32(108, 352.0);
        f.f32(112, 1.0);
        f.bytes[344..348].copy_from_slice(b"n+1\0");
        for &v in values {
            macro_rules! append {
                ($t:ty) => {{
                    let v = v as $t;
                    f.bytes
                        .extend_from_slice(&if le { v.to_le_bytes() } else { v.to_be_bytes() });
                }};
            }
            match code {
                2 => append!(u8),
                256 => append!(i8),
                4 => append!(i16),
                512 => append!(u16),
                8 => append!(i32),
                768 => append!(u32),
                16 => append!(f32),
                64 => append!(f64),
                _ => f.bytes.push(0),
            }
        }
        f
    }
    pub fn i16(&mut self, o: usize, v: i16) {
        self.bytes[o..o + 2].copy_from_slice(&if self.le {
            v.to_le_bytes()
        } else {
            v.to_be_bytes()
        });
    }
    pub fn f32(&mut self, o: usize, v: f32) {
        self.bytes[o..o + 4].copy_from_slice(&if self.le {
            v.to_le_bytes()
        } else {
            v.to_be_bytes()
        });
    }
    pub fn gzip(&self) -> Vec<u8> {
        let mut out = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        out.write_all(&self.bytes).unwrap();
        out.finish().unwrap()
    }
}
pub fn base() -> Fixture {
    Fixture::new(2, true, &[1., 2., 3., 4., 5., 6., 7., 8.])
}
pub fn scalar_cases() -> Vec<(i16, Vec<f64>)> {
    vec![
        (2, vec![0., 1., 127., 128., 254., 255., 2., 3.]),
        (256, vec![-128., -127., -1., 0., 1., 126., 127., 2.]),
        (4, vec![-32768., -32767., -1., 0., 1., 32766., 32767., 2.]),
        (512, vec![0., 1., 32767., 32768., 65534., 65535., 2., 3.]),
        (
            8,
            vec![
                -2147483648.,
                -2147483647.,
                -1.,
                0.,
                1.,
                2147483646.,
                2147483647.,
                2.,
            ],
        ),
        (
            768,
            vec![
                0.,
                1.,
                2147483647.,
                2147483648.,
                4294967294.,
                4294967295.,
                2.,
                3.,
            ],
        ),
        (
            16,
            vec![
                -0.,
                0.,
                -1.25,
                1.25,
                f32::MIN_POSITIVE as f64,
                f32::MAX as f64,
                2.,
                3.,
            ],
        ),
        (
            64,
            vec![
                -0.,
                0.,
                -1.25,
                1. + f64::EPSILON,
                f64::MIN_POSITIVE,
                1e-40,
                2.,
                3.,
            ],
        ),
    ]
}
pub fn mutations() -> Vec<(String, Fixture)> {
    let mut out = Vec::new();
    macro_rules! case {
        ($name:expr, $body:expr) => {{
            let mut f = base();
            ($body)(&mut f);
            out.push(($name.to_string(), f));
        }};
    }
    for n in [0, 2, -1, 8] {
        case!(format!("ndim-{n}"), |f: &mut Fixture| f.i16(40, n));
    }
    for n in [0, -1, 2] {
        case!(format!("dim4-{n}"), |f: &mut Fixture| {
            f.i16(40, 4);
            f.i16(48, n);
        });
    }
    for x in [
        0.,
        -1.,
        f32::NAN,
        f32::INFINITY,
        351.,
        352.,
        352.75,
        360.,
        361.,
    ] {
        case!(format!("offset-{:08x}", x.to_bits()), |f: &mut Fixture| f
            .f32(108, x));
    }
    for x in [0., -0., -2., f32::NAN, f32::INFINITY] {
        case!(format!("slope-{:08x}", x.to_bits()), |f: &mut Fixture| {
            f.f32(112, x);
            f.f32(116, 3.);
        });
    }
    for x in [f32::NAN, f32::INFINITY] {
        case!(format!("inter-{:08x}", x.to_bits()), |f: &mut Fixture| f
            .f32(116, x));
    }
    case!("truncated", |f: &mut Fixture| {
        f.bytes.pop();
    });
    case!("short-header", |f: &mut Fixture| f.bytes.truncate(348));
    case!("paired", |f: &mut Fixture| f.bytes[344..347]
        .copy_from_slice(b"ni1"));
    case!("magic-fourth", |f: &mut Fixture| f.bytes[347] = 255);
    case!("bitpix-trailing-extension", |f: &mut Fixture| {
        f.i16(72, -9);
        f.bytes[348] = 1;
        f.bytes.extend_from_slice(&[9; 8]);
    });
    let mut be = Fixture::new(2, false, &[1.; 8]);
    be.bytes[..4].copy_from_slice(&[1, 2, 3, 4]);
    out.push(("invalid-header-be".into(), be));
    case!("dimension-before-datatype", |f: &mut Fixture| {
        f.i16(42, 1);
        f.i16(70, -99);
    });
    case!("cap-before-datatype", |f: &mut Fixture| {
        for o in [42, 44, 46] {
            f.i16(o, 32767);
        }
        f.i16(70, -99);
    });
    case!("datatype-before-offset", |f: &mut Fixture| {
        f.i16(70, -99);
        f.f32(108, -1.);
    });
    for codes in [[0, 0], [1, 0], [0, 1], [2, 1], [1, 2]] {
        for qfac in [0., 2., -2.] {
            case!(format!("geometry-{codes:?}-{qfac}"), |f: &mut Fixture| {
                f.i16(252, codes[0]);
                f.i16(254, codes[1]);
                f.f32(76, qfac);
                for r in 0..3 {
                    f.f32(280 + r * 16 + r * 4, 2.);
                    f.f32(292 + r * 16, 10. + r as f32);
                    f.f32(268 + r * 4, 20. + r as f32);
                }
            });
        }
    }
    for units in [0, 1, 2, 3, 4, 5, 6, 7, 9, 35] {
        case!(format!("units-{units}"), |f: &mut Fixture| f.bytes[123] =
            units);
    }
    case!("bad-quaternion", |f: &mut Fixture| {
        f.i16(252, 1);
        f.f32(256, 2.);
    });
    case!("singular", |f: &mut Fixture| f.f32(80, 0.));
    case!("sample-before-affine", |f: &mut Fixture| {
        f.f32(112, f32::INFINITY);
        f.f32(80, f32::NAN);
    });
    case!("nonfinite-affine", |f: &mut Fixture| f.f32(80, f32::NAN));
    for x in [f64::NAN, f64::INFINITY, f64::MAX] {
        out.push((
            format!("sample-{:016x}", x.to_bits()),
            Fixture::new(64, true, &[x; 8]),
        ));
    }
    let mut f = Fixture::new(64, true, &[1.; 24]);
    f.i16(40, 4);
    f.i16(48, 3);
    for (i, v) in [1e16f64, 1., -1e16].into_iter().enumerate() {
        for j in 0..8 {
            f.bytes[352 + (i * 8 + j) * 8..360 + (i * 8 + j) * 8].copy_from_slice(&v.to_le_bytes());
        }
    }
    out.push(("channel-order".into(), f));
    out
}
pub const CHOOSE: &str = "Choose a NIfTI image (.nii or .nii.gz).";
pub const DIM: &str = "Unsupported image dimensions.";
pub const TRUNC: &str = "The NIfTI voxel data is truncated.";
pub const TYPE: &str = "Unsupported NIfTI datatype -99. Use a scalar intensity image.";
pub fn snapshot(name: &str, lines: Vec<String>) {
    let expected = match (name, cfg!(debug_assertions)) {
        ("synthsr", true) => include_str!("../snapshots/synthsr-debug.txt"),
        ("synthsr", false) => include_str!("../snapshots/synthsr-release.txt"),
        ("synthseg", true) => include_str!("../snapshots/synthseg-debug.txt"),
        ("synthseg", false) => include_str!("../snapshots/synthseg-release.txt"),
        _ => panic!("Unknown reader {name}"),
    };
    assert_eq!(lines.join("\n") + "\n", expected, "{name} baseline");
    if let Ok(dir) = std::env::var("NIFTI_SNAPSHOT_DIR") {
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(format!("{dir}/{name}.txt"), lines.join("\n") + "\n").unwrap();
    }
}
