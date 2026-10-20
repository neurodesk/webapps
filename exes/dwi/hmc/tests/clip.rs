//! `dwi_hmc::clip` against NiFreeze 3bcfb00's own `advanced_clip` (`tests/fixtures/clip.json`,
//! written by `make_clip_fixtures.py`). Every comparison is exact: the maps are integers after
//! `round(255 x)`, and the thresholds are compared bit for bit because the port does the same
//! float operations in the same precision and order as NumPy.

use dwi_hmc::clip::{ClipError, InputKind, advanced_clip, advanced_clip_in_place};
use serde_json::Value;

fn fixture() -> Value {
    let text = include_str!("fixtures/clip.json");
    serde_json::from_str(text).expect("clip.json")
}

fn case<'a>(fixture: &'a Value, name: &str) -> &'a Value {
    &fixture["cases"][name]
}

fn shape(case: &Value) -> [usize; 3] {
    let s: Vec<usize> = case["shape"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_u64().unwrap() as usize)
        .collect();
    [s[0], s[1], s[2]]
}

fn floats(case: &Value, key: &str) -> Vec<f64> {
    case[key]
        .as_array()
        .unwrap_or_else(|| panic!("{key}"))
        .iter()
        .map(|v| v.as_f64().unwrap())
        .collect()
}

fn ints(case: &Value, key: &str) -> Vec<i64> {
    case[key]
        .as_array()
        .unwrap_or_else(|| panic!("{key}"))
        .iter()
        .map(|v| v.as_i64().unwrap())
        .collect()
}

fn thresholds(case: &Value, key: &str) -> [f64; 2] {
    let t = floats(case, key);
    [t[0], t[1]]
}

fn as_ints<T: Copy + Into<f64>>(map: &[T]) -> Vec<i64> {
    map.iter()
        .map(|&v| {
            let v: f64 = v.into();
            assert_eq!(v, v.round(), "the map is integer-valued");
            v as i64
        })
        .collect()
}

#[test]
fn fixture_records_the_pinned_tools() {
    let tools = &fixture()["tools"];
    assert_eq!(
        tools["nifreeze"],
        "3bcfb00df1e008b4dfeb59c0d63717c335ba0d1e"
    );
    assert_eq!(tools["numpy"], "2.3.5");
    assert_eq!(tools["scipy"], "1.18.1");
    assert_eq!(tools["skimage"], "0.26.0");
}

/// The trivial model's `bzero`: the first registration writes the clipped map into the float64
/// array, and the second clips that map again, which changes it here as in NiFreeze.
#[test]
fn float64_is_clipped_in_place_and_again_on_the_next_visit() {
    let fixture = fixture();
    let c = case(&fixture, "float64");
    let mut bzero = floats(c, "input");

    let report = advanced_clip_in_place(&mut bzero, shape(c)).unwrap();
    assert_eq!(report.input, InputKind::Float);
    assert!(report.mutated);
    assert_eq!(
        [report.a_min, report.a_max],
        thresholds(c, "first_thresholds")
    );
    let first = as_ints(&bzero);
    assert_eq!(first, ints(c, "first"));

    let report = advanced_clip_in_place(&mut bzero, shape(c)).unwrap();
    assert!(report.mutated);
    assert_eq!(
        [report.a_min, report.a_max],
        thresholds(c, "second_thresholds")
    );
    let second = as_ints(&bzero);
    assert_eq!(second, ints(c, "second"));
    assert_ne!(first, second, "the second clip changes the map");
}

/// `inplace=False` casts even float64 input to float32, so its thresholds and map differ from
/// the in-place float64 ones.
#[test]
fn copy_computes_in_float32() {
    let fixture = fixture();
    let c = case(&fixture, "float64");
    let input = floats(c, "input");
    let out = advanced_clip(&input, shape(c)).unwrap();
    assert_eq!(
        out.iter().map(|&v| i64::from(v)).collect::<Vec<_>>(),
        ints(c, "copy_int16")
    );
    assert_ne!(
        thresholds(c, "copy_thresholds"),
        thresholds(c, "first_thresholds")
    );
}

#[test]
fn float32_is_clipped_in_place_in_float32() {
    let fixture = fixture();
    let c = case(&fixture, "float32");
    let mut data: Vec<f32> = floats(c, "input").iter().map(|&v| v as f32).collect();
    let report = advanced_clip_in_place(&mut data, shape(c)).unwrap();
    assert!(report.mutated);
    assert_eq!(
        [report.a_min, report.a_max],
        thresholds(c, "first_thresholds")
    );
    assert_eq!(as_ints(&data), ints(c, "first"));
}

/// ds005577's DWI is int16: NiFreeze clips a float32 copy and writes the unclipped volume.
#[test]
fn integer_input_is_not_changed_in_place() {
    let fixture = fixture();
    let c = case(&fixture, "int16");
    let input: Vec<i16> = ints(c, "input").iter().map(|&v| v as i16).collect();
    let mut data = input.clone();
    let report = advanced_clip_in_place(&mut data, shape(c)).unwrap();
    assert_eq!(report.input, InputKind::Integer);
    assert!(!report.mutated);
    assert_eq!(data, input);
    // The discarded computation is the one inplace=False returns.
    assert_eq!(
        [report.a_min, report.a_max],
        thresholds(c, "copy_thresholds")
    );
    let out = advanced_clip(&input, shape(c)).unwrap();
    assert_eq!(
        out.iter().map(|&v| i64::from(v)).collect::<Vec<_>>(),
        ints(c, "copy_int16")
    );
}

#[test]
fn ties_round_half_to_even() {
    let fixture = fixture();
    let c = case(&fixture, "ties");
    let input = floats(c, "input");
    let mut data = input.clone();
    let report = advanced_clip_in_place(&mut data, shape(c)).unwrap();
    assert_eq!([report.a_min, report.a_max], [0.0, 510.0]);
    let got = as_ints(&data);
    assert_eq!(got, ints(c, "first"));
    // At least one k + 0.5 rounds down, which half-away-from-zero would not.
    assert!(
        input
            .iter()
            .zip(&got)
            .any(|(&x, &y)| x % 4.0 == 1.0 && (y as f64) < 255.0 * (x / 510.0))
    );
}

#[test]
fn integer_input_still_reports_errors() {
    // A constant volume: a_max <= a_min, as NiFreeze raises ClippingValueError.
    let mut data = vec![7_i16; 4 * 4 * 4];
    let err = advanced_clip_in_place(&mut data, [4, 4, 4]).unwrap_err();
    assert_eq!(
        err,
        ClipError::InvalidThresholds {
            a_min: 7.0,
            a_max: 7.0
        }
    );
    assert!(data.iter().all(|&v| v == 7));
}

#[test]
fn refuses_nan_and_bad_shapes_without_writing() {
    let mut data = vec![1.0_f64; 27];
    data[4] = f64::NAN;
    let before = data.clone();
    assert_eq!(
        advanced_clip_in_place(&mut data, [3, 3, 3]),
        Err(ClipError::NaN)
    );
    assert!(
        data.iter()
            .zip(&before)
            .all(|(a, b)| a.to_bits() == b.to_bits())
    );
    assert_eq!(
        advanced_clip(&[0.0_f32; 8], [2, 2, 3]),
        Err(ClipError::Shape {
            len: 8,
            shape: [2, 2, 3]
        })
    );
    assert_eq!(
        advanced_clip(&[-1.0_f32; 8], [2, 2, 2]),
        Err(ClipError::EmptySelection)
    );
}

#[test]
fn refuses_empty_and_overflowing_shapes_without_writing() {
    for shape in [
        [0, 1, 1],
        [1, 0, 1],
        [1, 1, 0],
        [usize::MAX, 2, 1],
        [usize::MAX, 2, 0],
        [1usize << (usize::BITS - 1), 2, 1],
    ] {
        let expected = ClipError::Shape { len: 0, shape };
        assert_eq!(advanced_clip::<f32>(&[], shape), Err(expected));
        let mut empty = [];
        assert_eq!(
            advanced_clip_in_place::<f64>(&mut empty, shape),
            Err(expected)
        );
    }
    let mut data = [1.0_f64, 2.0];
    let shape = [usize::MAX, 2, 0];
    assert_eq!(
        advanced_clip_in_place(&mut data, shape),
        Err(ClipError::Shape { len: 2, shape })
    );
    assert_eq!(data, [1.0, 2.0]);
}
