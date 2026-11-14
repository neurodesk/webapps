//! Report-only hull census for packages/samsrf/validation/matlab/README.md: how
//! many of a recorded batch's `polyshape(P).convhull` vertex sets the production
//! model (`Hull::of_polygon`) or the experimental Clipper model reproduces
//! exactly, and which do not. For `causal_real` it also counts per source cloud
//! (parameter column 1). Evidence, not a gate.
//!   cargo run --release --features polyshape-experimental --example polyshape_hulls -- HOST_DIR CASE_ID production|experimental
//! `--oracle` instead reads a JSON list of polygons (lists of [x, y] as IEEE-754 bit
//! patterns, u64, because serde_json's default float parser is not correctly
//! rounded) from stdin and
//! writes both models' hull vertices, area and centroid for each, and the
//! experimental model's stages in grid units (the reducer in
//! packages/samsrf/validation/matlab/polyshape_reduce.py uses it):
//!   cargo run --release --features polyshape-experimental --example polyshape_hulls -- --oracle
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::Path;

fn describe(hull: Option<samsrf_core::geometry::Hull>) -> Value {
    match hull {
        None => serde_json::json!(null),
        Some(h) => serde_json::json!({"hull": h.vertices, "area": h.area(), "centroid": h.centroid()}),
    }
}

fn oracle() {
    let bits: Vec<Vec<[u64; 2]>> = serde_json::from_reader(std::io::stdin()).unwrap();
    let polygons: Vec<Vec<[f64; 2]>> = bits.iter().map(|p| p.iter().map(|q| q.map(f64::from_bits)).collect()).collect();
    let results: Vec<Value> = polygons.iter().map(|p| {
        let experimental = match samsrf_core::experimental::hull_of_polygon(p) {
            Ok(hull) => describe(hull),
            Err(e) => serde_json::json!({"error": e.to_string()}),
        };
        let stages = match samsrf_core::experimental::polyshape_stages(p) {
            Ok(Some((centre, scale, tolerance, ring, [first_union, first_clean, second_union, second_clean], hull, _))) => serde_json::json!({
                "centre": centre, "scale": scale, "tolerance": tolerance, "ring": ring,
                "firstUnion": first_union, "firstClean": first_clean, "secondUnion": second_union, "secondClean": second_clean, "hull": hull,
            }),
            Ok(None) => serde_json::json!(null),
            Err(e) => serde_json::json!({"error": e.to_string()}),
        };
        serde_json::json!({"production": describe(samsrf_core::geometry::Hull::of_polygon(p)), "experimental": experimental, "experimentalStages": stages})
    }).collect();
    serde_json::to_writer(std::io::stdout(), &results).unwrap();
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("--oracle") {
        oracle();
        return;
    }
    assert_eq!(
        args.len(),
        4,
        "usage: polyshape_hulls HOST_DIR CASE_ID production|experimental"
    );
    let (root, id, model) = (Path::new(&args[1]), args[2].as_str(), args[3].as_str());
    assert!(
        model == "production" || model == "experimental",
        "model must be production or experimental"
    );
    let meta: Value =
        serde_json::from_slice(&std::fs::read(root.join("geometry.json")).unwrap()).unwrap();
    let case = meta["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["id"] == id)
        .unwrap_or_else(|| panic!("no {id}"));
    let shape = |d: &Value| -> [usize; 2] {
        let dimensions = d["shape"].as_array().expect("missing descriptor shape");
        assert_eq!(dimensions.len(), 2, "expected a matrix descriptor");
        std::array::from_fn(|i| {
            usize::try_from(dimensions[i].as_u64().expect("invalid dimension")).unwrap()
        })
    };
    let read = |d: &Value| -> Vec<f64> {
        assert_eq!(d["class"], "double", "expected double data");
        assert_eq!(d["imaginary"], "", "expected real data");
        let [rows, columns] = shape(d);
        let expected_bytes = rows
            .checked_mul(columns)
            .and_then(|n| n.checked_mul(8))
            .expect("descriptor size overflow");
        let bytes = std::fs::read(root.join(d["file"].as_str().unwrap())).unwrap();
        assert_eq!(
            bytes.len(),
            expected_bytes,
            "descriptor and file length differ"
        );
        bytes
            .as_chunks::<8>()
            .0
            .iter()
            .map(|b| f64::from_le_bytes(*b))
            .collect()
    };
    let split = |field: &str, counts: &str| -> Vec<Vec<[f64; 2]>> {
        let all = read(&case[field]);
        let [rows, columns] = shape(&case[field]);
        assert_eq!(columns, 2, "coordinates must have two columns");
        assert_eq!(shape(&case[counts])[1], 1, "counts must be a column vector");
        let mut offset = 0;
        let result = read(&case[counts])
            .iter()
            .map(|&n| {
                assert!(
                    n.is_finite() && n >= 0.0 && n.fract() == 0.0 && n <= rows as f64,
                    "invalid row count {n}"
                );
                let n = n as usize;
                assert!(n <= rows - offset, "polygon exceeds available rows");
                let polygon = (offset..offset + n)
                    .map(|i| [all[i], all[rows + i]])
                    .collect();
                offset += n;
                polygon
            })
            .collect();
        assert_eq!(offset, rows, "{field}: unconsumed rows");
        result
    };
    let polygons = split("points", "counts");
    let hulls = split("hull", "hullCounts");
    assert_eq!(
        polygons.len(),
        hulls.len(),
        "polygon and hull inventories differ"
    );
    assert_eq!(
        case["cases"].as_u64(),
        Some(polygons.len() as u64),
        "case inventory differs"
    );
    let sorted = |v: &[[f64; 2]]| {
        let mut v = v.to_vec();
        v.sort_by(|a, b| a[0].total_cmp(&b[0]).then(a[1].total_cmp(&b[1])));
        v
    };
    let mut differing = Vec::new();
    let mut errors = 0;
    for (i, polygon) in polygons.iter().enumerate() {
        let hull = if model == "experimental" {
            match samsrf_core::experimental::hull_of_polygon(polygon) {
                Ok(hull) => hull,
                Err(_) => {
                    errors += 1;
                    differing.push(i);
                    continue;
                }
            }
        } else {
            samsrf_core::geometry::Hull::of_polygon(polygon)
        };
        if sorted(&hull.map(|h| h.vertices).unwrap_or_default()) != sorted(&hulls[i]) {
            differing.push(i);
        }
    }
    println!(
        "{id} {model}: {} of {} hull vertex sets equal MATLAB's ({errors} model errors)",
        polygons.len() - differing.len(),
        polygons.len()
    );
    println!("differing: {differing:?}");
    if id == "causal_real" {
        assert_eq!(
            shape(&case["parameters"]),
            [polygons.len(), 5],
            "causal parameters must have five columns and one row per polygon"
        );
        let parameters = read(&case["parameters"]);
        let mut by_source: BTreeMap<u64, (usize, usize)> = BTreeMap::new();
        for (i, source) in parameters.iter().take(polygons.len()).enumerate() {
            assert!(
                source.is_finite()
                    && *source >= 0.0
                    && source.fract() == 0.0
                    && *source < u64::MAX as f64,
                "invalid source id"
            );
            let entry = by_source.entry(*source as u64).or_default();
            entry.1 += 1;
            if !differing.contains(&i) {
                entry.0 += 1;
            }
        }
        for (source, (equal, total)) in by_source {
            println!("source {source}: {equal} of {total}");
        }
    }
}
