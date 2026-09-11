use greedy_rs_core::{
    AffineMetric, Transform, decode_image, decode_vector_field, encode_image, encode_vector_field,
    read_matrix, register_affine, register_nmi_svf, reslice,
};
use wasm_bindgen::prelude::*;

// Exposes async `initThreadPool` to the browser glue. It must be called before
// registration so the core's existing Rayon slab loops use Web Workers.
pub use wasm_bindgen_rayon::init_thread_pool;

fn wasm_error(error: greedy_rs_core::Error) -> JsValue {
    JsValue::from_str(&error.to_string())
}

fn parse_metric(metric: &str) -> Result<AffineMetric, JsValue> {
    match metric.to_ascii_uppercase().as_str() {
        "SSD" => Ok(AffineMetric::Ssd),
        "NMI" => Ok(AffineMetric::Nmi),
        _ => Err(JsValue::from_str("metric must be SSD or NMI")),
    }
}

fn parse_iterations(value: &str) -> Result<[usize; 3], JsValue> {
    value
        .split('x')
        .map(str::parse::<usize>)
        .collect::<Result<Vec<_>, _>>()
        .ok()
        .and_then(|values| values.try_into().ok())
        .ok_or_else(|| JsValue::from_str("iterations must be three x-separated integers"))
}

/// Register moving to fixed using the light 3-D affine interface. `metric` is
/// `SSD` or `NMI`; `iterations` uses Greedy's `100x50x10` notation.
#[wasm_bindgen]
pub fn register_affine_wasm(
    fixed: &[u8],
    moving: &[u8],
    metric: &str,
    iterations: &str,
) -> Result<String, JsValue> {
    let fixed = decode_image(fixed).map_err(wasm_error)?;
    let moving = decode_image(moving).map_err(wasm_error)?;
    let matrix = register_affine(
        fixed,
        moving,
        parse_metric(metric)?,
        parse_iterations(iterations)?,
        false,
    )
    .map_err(wasm_error)?;
    Ok(matrix
        .0
        .iter()
        .map(|row| format!("{} {} {} {}", row[0], row[1], row[2], row[3]))
        .collect::<Vec<_>>()
        .join("\n"))
}

/// Register moving to fixed with NMI stationary velocity. `matrix` is the
/// optional affine initialization in RAS text form; pass an identity matrix
/// when the images are already aligned. Inputs and output are raw `.nii`
/// bytes; browser callers should use CompressionStream for `.nii.gz`. The
/// returned NIfTI is the residual physical-LPS displacement field used before
/// that affine.
#[wasm_bindgen]
pub fn register_nmi_svf_wasm(
    fixed: &[u8],
    moving: &[u8],
    matrix: &str,
    iterations: &str,
) -> Result<Vec<u8>, JsValue> {
    let fixed = decode_image(fixed).map_err(wasm_error)?;
    let moving = decode_image(moving).map_err(wasm_error)?;
    let matrix = read_matrix(matrix).map_err(wasm_error)?;
    let moving =
        reslice(&fixed.grid, &moving, &[Transform::Affine(matrix)], None).map_err(wasm_error)?;
    let warp = register_nmi_svf(
        fixed,
        moving,
        parse_iterations(iterations)?,
        false,
        |_, _| {},
    )
    .map_err(wasm_error)?;
    encode_vector_field(&warp, false).map_err(wasm_error)
}

/// Reslice a NIfTI moving image into the fixed image's grid through one RAS affine.
#[wasm_bindgen]
pub fn reslice_affine(fixed: &[u8], moving: &[u8], matrix: &str) -> Result<Vec<u8>, JsValue> {
    let fixed = decode_image(fixed).map_err(wasm_error)?;
    let moving = decode_image(moving).map_err(wasm_error)?;
    let matrix = read_matrix(matrix).map_err(wasm_error)?;
    let output =
        reslice(&fixed.grid, &moving, &[Transform::Affine(matrix)], None).map_err(wasm_error)?;
    encode_image(&output, false).map_err(wasm_error)
}

/// Matches the production `-r warp.nii.gz aff.mat` transform order.
#[wasm_bindgen]
pub fn reslice_warp_affine(
    fixed: &[u8],
    moving: &[u8],
    warp: &[u8],
    matrix: &str,
) -> Result<Vec<u8>, JsValue> {
    let fixed = decode_image(fixed).map_err(wasm_error)?;
    let moving = decode_image(moving).map_err(wasm_error)?;
    let warp = decode_vector_field(warp).map_err(wasm_error)?;
    let matrix = read_matrix(matrix).map_err(wasm_error)?;
    let output = reslice(
        &fixed.grid,
        &moving,
        &[Transform::Warp(warp), Transform::Affine(matrix)],
        None,
    )
    .map_err(wasm_error)?;
    encode_image(&output, false).map_err(wasm_error)
}
