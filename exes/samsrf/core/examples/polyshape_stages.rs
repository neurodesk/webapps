//! Dumps the polyshape model's stages for every polygon of a recorded batch, for
//! packages/samsrf/validation/matlab/polyshape_census.py:
//!   cargo run --release --example polyshape_stages -- HOST_DIR CASE_ID OUT.json
//! `--replay FIELD` (`points`, `simplified`, `collinearVertices`) runs the model on
//! that recorded field's NaN-separated boundaries instead of the input points:
//!   cargo run --release --example polyshape_stages -- --replay FIELD HOST_DIR CASE_ID OUT.json
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
    let replay = (args.get(1).map(String::as_str) == Some("--replay")).then(|| args[2].clone());
    let args: Vec<String> = if replay.is_some() { [vec![args[0].clone()], args[3..].to_vec()].concat() } else { args };
    let (root, id, out) = (Path::new(&args[1]), &args[2], &args[3]);
    let meta: Value = serde_json::from_slice(&std::fs::read(root.join("geometry.json")).unwrap()).unwrap();
    let case = meta["cases"].as_array().unwrap().iter().find(|c| c["id"] == id.as_str()).unwrap_or_else(|| panic!("no {id}"));
    let read = |d: &Value| -> Vec<f64> { std::fs::read(root.join(d["file"].as_str().unwrap())).unwrap().chunks(8).map(|b| f64::from_le_bytes(b.try_into().unwrap())).collect() };
    let (field, count_field) = match replay.as_deref() {
        None | Some("points") => ("points", "counts"),
        Some("simplified") => ("simplified", "simplifiedCounts"),
        Some("collinearVertices") => ("collinearVertices", "collinearCounts"),
        Some(other) => panic!("unknown field {other}"),
    };
    let all = read(&case[field]);
    let rows = all.len() / 2;
    let counts = read(&case[count_field]);
    let mut offset = 0;
    let mut dump = Vec::new();
    for &n in &counts {
        let n = n.max(0.0) as usize;
        let polygon: Vec<[f64; 2]> = (offset..offset + n).map(|i| [all[i], all[rows + i]]).collect();
        offset += n;
        let boundaries: Vec<Vec<[f64; 2]>> = polygon.split(|p| p[0].is_nan()).filter(|b| !b.is_empty()).map(<[_]>::to_vec).collect();
        let result = if replay.is_some() { samsrf_core::geometry::polyshape_stages_of_boundaries(&boundaries) } else { samsrf_core::geometry::polyshape_stages(&polygon) };
        dump.push(match result {
            Ok(Some((centre, scale, tolerance, ring, stages, hull, order))) => json!({"firstUnionOrder": order, "centre": centre, "scale": scale, "tolerance": tolerance, "ring": ring, "firstUnion": stages[0], "firstClean": stages[1], "secondUnion": stages[2], "secondClean": stages[3], "hull": hull}),
            Ok(None) => Value::Null,
            Err(e) => json!({"error": e.to_string()}),
        });
    }
    std::fs::write(out, serde_json::to_string(&dump).unwrap()).unwrap();
}
