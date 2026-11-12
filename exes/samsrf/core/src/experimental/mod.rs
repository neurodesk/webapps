//! Experimental geometry, compiled only with the `polyshape-experimental` feature,
//! which no shipped build (the WebAssembly module, hence the web app and the
//! `samsrf` command line) enables. It holds a Clipper-based model of MATLAB's
//! `polyshape` that matches more recorded polygons than the production model in
//! `crate::polyshape` but regresses four that the production model matches
//! (#732). Diagnostics and validation gates only; nothing in the library calls it.

mod clipper;
mod polyshape;

use crate::error::{Error, Result};
use crate::geometry::Hull;

#[cfg(target_arch = "wasm32")]
compile_error!("polyshape-experimental must never be enabled in a WebAssembly build");

/// The experimental model's `Hull::of_polygon`: `Ok(None)` where the shape is
/// empty, an error where the model cannot follow MATLAB and MATLAB's result was
/// not recorded (coordinates outside its integer grid, or a failed Clipper sweep).
pub fn hull_of_polygon(points: &[[f64; 2]]) -> Result<Option<Hull>> {
    Ok(polyshape_vertices(points)?.1)
}

/// MATLAB's `polyshape(points).Vertices` as a set (the model does not reproduce
/// their ring order), and `hull_of_polygon(points)`.
pub fn polyshape_vertices(points: &[[f64; 2]]) -> Result<(Vec<[f64; 2]>, Option<Hull>)> {
    use polyshape::Unresolved;
    let simplified = polyshape::simplify(points).map_err(|failure| Error::Shape(match failure {
        Unresolved::Grid => "polyshape: the coordinates do not fit the fixed-point grid MATLAB's polyshape is reproduced on".into(),
        Unresolved::Clipper(failure) => format!("polyshape: Clipper's union failed ({failure:?}); MATLAB's result for this polygon was not recorded"),
    }))?;
    let hull = simplified.hull.map(|vertices| Hull { vertices }).filter(|hull| hull.area() > 0.0);
    Ok((simplified.vertices, hull))
}

/// The model's stages in grid units: `(centre, scale, tolerance, input ring,
/// [first union, first clean, second union, second clean], hull, first union's
/// creation order)`.
pub type StageDump = ([f64; 2], f64, f64, Vec<(i64, i64)>, [Vec<Vec<(i64, i64)>>; 4], Vec<(i64, i64)>, Vec<Vec<usize>>);

fn dump(stages: std::result::Result<Option<polyshape::Stages>, polyshape::Unresolved>) -> Result<Option<StageDump>> {
    let stages = stages.map_err(|failure| Error::Shape(format!("polyshape: {failure:?}")))?;
    Ok(stages.map(|s| (s.grid.centre, s.grid.scale, s.grid.tolerance, s.ring, [s.first_union, s.first_clean, s.second_union, s.second_clean], s.hull, s.first_union_order)))
}

/// The model's stages for one polygon.
pub fn polyshape_stages(points: &[[f64; 2]]) -> Result<Option<StageDump>> {
    dump(polyshape::stages(points))
}

/// `polyshape_stages` for several boundaries united together (replays of
/// NaN-separated recorded polyshape vertices).
pub fn polyshape_stages_of_boundaries(boundaries: &[Vec<[f64; 2]>]) -> Result<Option<StageDump>> {
    dump(polyshape::stages_of_boundaries(boundaries))
}

/// The model's grid cleaner on one ring, for replays.
pub fn polyshape_clean(path: &[(i64, i64)], tolerance: f64) -> Vec<(i64, i64)> {
    polyshape::clean(path, tolerance)
}
