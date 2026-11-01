use greedy_rs_core::{
    AffineMetric, AffineStart, DEFAULT_AFFINE_JITTER, Interpolation, SvfMetric, Transform,
    decode_image, decode_vector_field, encode_image, encode_vector_field, read_matrix,
    register_affine, register_affine_masked, register_nmi_svf, register_rigid_masked, register_svf,
    reslice, reslice_with_background,
};
use wasm_bindgen::prelude::*;

// Exposes async `initThreadPool` to the browser glue. It must be called before
// registration so the core's existing Rayon slab loops use Web Workers. Without
// the `threads` feature the module runs single-threaded, as in Node.
#[cfg(feature = "threads")]
pub use wasm_bindgen_rayon::init_thread_pool;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console, js_name = error)]
    fn report_panic(message: &str);
}

#[wasm_bindgen(start)]
pub fn initialize_diagnostics() {
    std::panic::set_hook(Box::new(|info| report_panic(&info.to_string())));
}

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

fn affine_start(image_centers: bool) -> AffineStart {
    if image_centers {
        AffineStart::ImageCenters
    } else {
        AffineStart::Identity
    }
}

/// Register moving to fixed using the light 3-D affine interface. `metric` is
/// `SSD` or `NMI`; `iterations` uses Greedy's `100x50x10` notation;
/// `image_centers` is Greedy's `-ia-image-centers` (otherwise the identity).
#[wasm_bindgen]
pub fn register_affine_wasm(
    fixed: &[u8],
    moving: &[u8],
    metric: &str,
    iterations: &str,
    image_centers: bool,
) -> Result<String, JsValue> {
    let fixed = decode_image(fixed).map_err(wasm_error)?;
    let moving = decode_image(moving).map_err(wasm_error)?;
    let matrix = register_affine(
        fixed,
        moving,
        affine_start(image_centers),
        parse_metric(metric)?,
        parse_iterations(iterations)?,
        false,
        DEFAULT_AFFINE_JITTER,
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

/// `greedy -a [-gm MASK] [-ia-image-centers | -ia FILE]` (12 DOF): the RAS matrix text exactly
/// as the CLI writes `-o aff.mat`. Inputs are raw `.nii` bytes; `mask` restricts the metric to
/// the fixed image's mask; `initial`, the text of an `-ia` matrix, overrides `image_centers`.
#[wasm_bindgen]
pub fn register_affine_masked_wasm(
    fixed: &[u8],
    moving: &[u8],
    mask: Option<Vec<u8>>,
    metric: &str,
    iterations: &str,
    image_centers: bool,
    initial: Option<String>,
) -> Result<String, JsValue> {
    register_linear(
        12,
        fixed,
        moving,
        mask,
        metric,
        iterations,
        image_centers,
        initial,
    )
}

/// `greedy -a -dof 6`, otherwise as `register_affine_masked_wasm`: a rigid RAS matrix as the CLI
/// writes it.
#[wasm_bindgen]
pub fn register_rigid_masked_wasm(
    fixed: &[u8],
    moving: &[u8],
    mask: Option<Vec<u8>>,
    metric: &str,
    iterations: &str,
    image_centers: bool,
    initial: Option<String>,
) -> Result<String, JsValue> {
    register_linear(
        6,
        fixed,
        moving,
        mask,
        metric,
        iterations,
        image_centers,
        initial,
    )
}

#[allow(clippy::too_many_arguments)]
fn register_linear(
    dof: u8,
    fixed: &[u8],
    moving: &[u8],
    mask: Option<Vec<u8>>,
    metric: &str,
    iterations: &str,
    image_centers: bool,
    initial: Option<String>,
) -> Result<String, JsValue> {
    let start = match initial {
        Some(text) => AffineStart::Matrix(read_matrix(&text).map_err(wasm_error)?),
        None => affine_start(image_centers),
    };
    let fixed = decode_image(fixed).map_err(wasm_error)?;
    let moving = decode_image(moving).map_err(wasm_error)?;
    let mask = mask
        .map(|m| decode_image(&m))
        .transpose()
        .map_err(wasm_error)?;
    let register = if dof == 6 {
        register_rigid_masked
    } else {
        register_affine_masked
    };
    let matrix = register(
        fixed,
        moving,
        mask,
        start,
        parse_metric(metric)?,
        parse_iterations(iterations)?,
        false,
        DEFAULT_AFFINE_JITTER,
    )
    .map_err(wasm_error)?;
    Ok(matrix
        .0
        .iter()
        .map(|row| format!("{} {} {} {}\n", row[0], row[1], row[2], row[3]))
        .collect())
}

/// `greedy -sv -m NMI [-gm MASK] [-it aff.mat]`: raw `.nii` displacement field, as the CLI writes `-o`.
/// Without `matrix` the moving image is used as given (no initial transform).
#[wasm_bindgen]
pub fn register_nmi_svf_masked_wasm(
    fixed: &[u8],
    moving: &[u8],
    mask: Option<Vec<u8>>,
    matrix: Option<String>,
    iterations: &str,
) -> Result<Vec<u8>, JsValue> {
    register_svf_masked_wasm(fixed, moving, mask, matrix, "NMI", iterations)
}

/// `greedy -sv -m METRIC [-gm MASK] [-it aff.mat]` with `metric` `NMI` or `NCC 2x2x2` (the
/// box-window radius in voxels): raw `.nii` displacement field, as the CLI writes `-o`.
#[wasm_bindgen]
pub fn register_svf_masked_wasm(
    fixed: &[u8],
    moving: &[u8],
    mask: Option<Vec<u8>>,
    matrix: Option<String>,
    metric: &str,
    iterations: &str,
) -> Result<Vec<u8>, JsValue> {
    let metric = parse_svf_metric(metric)?;
    let fixed = decode_image(fixed).map_err(wasm_error)?;
    let mut moving = decode_image(moving).map_err(wasm_error)?;
    if let Some(m) = matrix {
        let affine = read_matrix(&m).map_err(wasm_error)?;
        moving = reslice(&fixed.grid, &moving, &[Transform::Affine(affine)], None)
            .map_err(wasm_error)?;
    }
    let mask = mask
        .map(|m| decode_image(&m))
        .transpose()
        .map_err(wasm_error)?;
    let warp = register_svf(
        fixed,
        moving,
        mask,
        metric,
        parse_iterations(iterations)?,
        false,
        |_, _| {},
    )
    .map_err(wasm_error)?;
    encode_vector_field(&warp, false).map_err(wasm_error)
}

fn parse_svf_metric(value: &str) -> Result<SvfMetric, JsValue> {
    let invalid =
        || JsValue::from_str("metric must be NMI or NCC with a radius, such as NCC 2x2x2");
    let mut words = value.split_whitespace();
    match (
        words.next().map(str::to_ascii_uppercase).as_deref(),
        words.next(),
        words.next(),
    ) {
        (Some("NMI"), None, None) => Ok(SvfMetric::Nmi),
        (Some("NCC"), Some(radius), None) => {
            let values = radius
                .split('x')
                .map(str::parse::<usize>)
                .collect::<Result<Vec<_>, _>>()
                .map_err(|_| invalid())?;
            match values[..] {
                [r] => Ok(SvfMetric::Ncc([r; 3])),
                [x, y, z] => Ok(SvfMetric::Ncc([x, y, z])),
                _ => Err(invalid()),
            }
        }
        _ => Err(invalid()),
    }
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

/// Reslice through the standard warp/affine pair and an optional preceding
/// moving-to-anatomical affine. This matches SYNcro's single-pass transform
/// chain for a pathological scan and its lesion mask.
#[wasm_bindgen]
pub fn reslice_warp_affine_options(
    fixed: &[u8],
    moving: &[u8],
    warp: &[u8],
    matrix: &str,
    preceding_matrix: Option<String>,
    nearest: bool,
    background: f32,
) -> Result<Vec<u8>, JsValue> {
    let fixed = decode_image(fixed).map_err(wasm_error)?;
    let moving = decode_image(moving).map_err(wasm_error)?;
    let warp = decode_vector_field(warp).map_err(wasm_error)?;
    let mut chain = vec![
        Transform::Warp(warp),
        Transform::Affine(read_matrix(matrix).map_err(wasm_error)?),
    ];
    if let Some(value) = preceding_matrix {
        chain.push(Transform::Affine(read_matrix(&value).map_err(wasm_error)?));
    }
    let interpolation = if nearest {
        Interpolation::Nearest
    } else {
        Interpolation::Linear
    };
    let output = reslice_with_background(
        &fixed.grid,
        &moving,
        &chain,
        None,
        interpolation,
        background,
    )
    .map_err(wasm_error)?;
    encode_image(&output, false).map_err(wasm_error)
}

/// Reslice through one affine with an explicit interpolation and background.
/// The ANTs adapter uses this to place a pathological image in the primary
/// image grid before applying its nonlinear transform.
#[wasm_bindgen]
pub fn reslice_affine_options(
    fixed: &[u8],
    moving: &[u8],
    matrix: &str,
    nearest: bool,
    background: f32,
) -> Result<Vec<u8>, JsValue> {
    let fixed = decode_image(fixed).map_err(wasm_error)?;
    let moving = decode_image(moving).map_err(wasm_error)?;
    let chain = [Transform::Affine(read_matrix(matrix).map_err(wasm_error)?)];
    let interpolation = if nearest {
        Interpolation::Nearest
    } else {
        Interpolation::Linear
    };
    let output = reslice_with_background(
        &fixed.grid,
        &moving,
        &chain,
        None,
        interpolation,
        background,
    )
    .map_err(wasm_error)?;
    encode_image(&output, false).map_err(wasm_error)
}
