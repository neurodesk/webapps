//! Dumps the polyshape model's stages for every polygon of a recorded batch, for
//! packages/samsrf/validation/matlab/polyshape_census.py:
//!   cargo run --release --example polyshape_stages -- HOST_DIR CASE_ID OUT.json
//! `--clean` instead reads a JSON batch of grid rings and tolerances from stdin
//! and writes the results of the model's actual cleaner to stdout.
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::Path;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("--clean") {
        #[derive(Deserialize)]
        struct Request { rings: Vec<Vec<(i64, i64)>>, tolerance: f64 }
        let requests: Vec<Request> = serde_json::from_reader(std::io::stdin()).unwrap();
        let cleaned: Vec<_> = requests.iter().map(|request| {
            request.rings.iter().map(|ring| samsrf_core::geometry::polyshape_clean(ring, request.tolerance)).collect::<Vec<_>>()
        }).collect();
        serde_json::to_writer(std::io::stdout(), &cleaned).unwrap();
        return;
    }
    let (root, id, out) = (Path::new(&args[1]), &args[2], &args[3]);
    let meta: Value = serde_json::from_slice(&std::fs::read(root.join("geometry.json")).unwrap()).unwrap();
    let case = meta["cases"].as_array().unwrap().iter().find(|c| c["id"] == id.as_str()).unwrap_or_else(|| panic!("no {id}"));
    let read = |d: &Value| -> Vec<f64> { std::fs::read(root.join(d["file"].as_str().unwrap())).unwrap().chunks(8).map(|b| f64::from_le_bytes(b.try_into().unwrap())).collect() };
    let all = read(&case["points"]);
    let rows = all.len() / 2;
    let counts = read(&case["counts"]);
    let mut offset = 0;
    let mut dump = Vec::new();
    for &n in &counts {
        let polygon: Vec<[f64; 2]> = (offset..offset + n as usize).map(|i| [all[i], all[rows + i]]).collect();
        offset += n as usize;
        dump.push(match samsrf_core::geometry::polyshape_stages(&polygon) {
            Ok(Some((centre, scale, tolerance, ring, stages, hull, order))) => json!({"firstUnionOrder": order, "centre": centre, "scale": scale, "tolerance": tolerance, "ring": ring, "firstUnion": stages[0], "firstClean": stages[1], "secondUnion": stages[2], "secondClean": stages[3], "hull": hull}),
            Ok(None) => Value::Null,
            Err(e) => json!({"error": e.to_string()}),
        });
    }
    std::fs::write(out, serde_json::to_string(&dump).unwrap()).unwrap();
}
