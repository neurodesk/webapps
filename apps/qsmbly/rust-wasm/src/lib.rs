//! QSM-WASM: WebAssembly bindings for QSM processing
//!
//! This crate provides #[wasm_bindgen] wrappers around qsm-core algorithms
//! for browser-based medical image processing.

// Every export mirrors the flat argument list its JS caller passes (typed arrays, dimensions,
// voxel sizes, then algorithm parameters); wasm-bindgen has no cheaper way to take them, so
// clippy's argument-count lint flags nearly every function here without pointing at a problem.
#![allow(clippy::too_many_arguments)]

// qsm-core comes through qsmxt-engine's re-export, so qsmbly has a single pin (on QSMxT) and runs
// exactly the qsm-core QSMxT was built against.
use qsmxt_engine::qsm_core;
use wasm_bindgen::prelude::*;

pub mod engine;
pub mod outputs;
pub mod settings;

#[cfg(feature = "debug-log")]
#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console)]
    fn log(s: &str);
}

/// `console.log` for development builds. Without the `debug-log` feature it compiles to nothing:
/// the arguments are still type-checked (so values used only in a log line don't warn as
/// unused), but no string is formatted and nothing crosses into JS.
macro_rules! console_log {
    ($($t:tt)*) => {{
        #[cfg(feature = "debug-log")]
        log(&format!($($t)*));
        #[cfg(not(feature = "debug-log"))]
        let _ = format_args!($($t)*);
    }};
}

/// The message of the last panic, kept for the page: the build aborts on a panic
/// (`panic=abort`), so the call it happened in throws only `RuntimeError: unreachable`, and the
/// page asks [`take_panic_wasm`] what happened. One for every thread of a threaded build.
static LAST_PANIC: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

/// What a panic says, and where it happened.
fn panic_text(info: &std::panic::PanicHookInfo<'_>) -> String {
    let payload = info.payload();
    let message = payload
        .downcast_ref::<&str>()
        .map(|s| s.to_string())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "a panic with no message".to_string());
    match info.location() {
        Some(l) => format!("{message} (at {}:{})", l.file(), l.line()),
        None => message,
    }
}

/// Install the panic hook: a panic's message is kept for [`take_panic_wasm`] and, with the
/// `console_error_panic_hook` feature, written to the console with its stack.
#[wasm_bindgen(start)]
pub fn init() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        std::panic::set_hook(Box::new(|info| {
            if let Ok(mut last) = LAST_PANIC.lock() {
                *last = Some(panic_text(info));
            }
            #[cfg(feature = "console_error_panic_hook")]
            console_error_panic_hook::hook(info);
        }));
    });
}

/// The message of the last panic (and where it happened), once: what a call that threw
/// `RuntimeError: unreachable` died of. `undefined` when nothing has panicked since it was last
/// asked.
#[wasm_bindgen]
pub fn take_panic_wasm() -> Option<String> {
    LAST_PANIC.lock().ok().and_then(|mut last| last.take())
}

// Rayon threadpool bootstrap for wasm. JS must `await init_thread_pool(n)` once after module
// init (before any rayon-backed call) on a cross-origin-isolated page. Only present in threaded
// (`parallel`) builds; single-threaded builds omit it and the JS falls back gracefully.
#[cfg(feature = "parallel")]
pub use wasm_bindgen_rayon::init_thread_pool;

/// Build a JS `Error` to throw across the wasm_bindgen boundary.
///
/// `JsValue::from_str` throws a bare string, which leaves `error.message`
/// undefined in the worker's `catch (error) { postError(error.message) }` —
/// so the user sees "undefined" instead of the failure. A real `Error` carries
/// the message through unchanged.
fn js_err(e: impl std::fmt::Display) -> JsValue {
    js_sys::Error::new(&e.to_string()).into()
}

/// Gyromagnetic ratio of hydrogen protons (Hz/T)
const GYROMAGNETIC_RATIO: f64 = 42.576e6;

/// Scale factor converting Hz → ppm at `field_strength` tesla.
///
/// A missing or non-positive field strength is an error: there is no factor that turns Hz into
/// ppm without it, and passing the field through unscaled would label Hz values as ppm.
fn ppm_scale(field_strength: f64) -> Result<f64, String> {
    if field_strength > 0.0 && field_strength.is_finite() {
        Ok(1e6 / (GYROMAGNETIC_RATIO * field_strength))
    } else {
        Err(format!(
            "field strength must be a positive number of tesla, got {field_strength}"
        ))
    }
}

fn hz_to_ppm_scale(field_strength: f64) -> Result<f64, JsValue> {
    ppm_scale(field_strength).map_err(js_err)
}

// ============================================================================
// Input validation
// ============================================================================
//
// wasm-bindgen hands typed arrays over as plain slices, and qsm-core indexes them on the
// assumption that they hold the sizes the dimensions imply. A mismatch panics, and threaded
// builds use panic=abort, so the worker dies without a message. Every export that takes a volume
// checks its inputs first and throws a readable JS error instead. The `String`-returning halves
// are what the host tests exercise, since js_sys values can't be built off-wasm.

/// Product of `factors` (e.g. `[nx, ny, nz]`), or an error if it overflows `usize`.
fn checked_count(factors: &[usize]) -> Result<usize, String> {
    factors
        .iter()
        .try_fold(1usize, |acc, &f| acc.checked_mul(f))
        .ok_or_else(|| format!("array size {factors:?} overflows the address space"))
}

fn n_elements(factors: &[usize]) -> Result<usize, JsValue> {
    checked_count(factors).map_err(js_err)
}

fn len_mismatch(name: &str, len: usize, expected: usize, allow_empty: bool) -> Result<(), String> {
    if len == expected || (allow_empty && len == 0) {
        Ok(())
    } else {
        Err(format!("{name} has {len} elements, expected {expected}"))
    }
}

/// Throw unless `data` holds exactly `expected` elements.
fn check_len<T>(name: &str, data: &[T], expected: usize) -> Result<(), JsValue> {
    len_mismatch(name, data.len(), expected, false).map_err(js_err)
}

/// As [`check_len`], but also accept an empty slice, which these exports read as "not provided".
fn check_len_or_empty<T>(name: &str, data: &[T], expected: usize) -> Result<(), JsValue> {
    len_mismatch(name, data.len(), expected, true).map_err(js_err)
}

// ============================================================================
// Marshalling helpers
// ============================================================================

/// Forward qsm-core's `(current, total)` progress reports to a JS callback. A callback that
/// throws is ignored: progress is advisory and must not abort the computation.
fn js_progress(cb: &js_sys::Function) -> impl Fn(usize, usize) + '_ {
    move |current, total| {
        let _ = cb.call2(
            &JsValue::NULL,
            &JsValue::from(current as u32),
            &JsValue::from(total as u32),
        );
    }
}

/// Pack `(local_field, eroded_mask)` as `[local_field ; eroded_mask]`, the mask as 0.0/1.0.
///
/// The worker splits the result at `nx*ny*nz` and thresholds the second half back into a mask,
/// so the mask stays f64: a compact `Uint8Array` would need those JS call sites to change too.
fn field_and_mask((field, mask): (Vec<f64>, Vec<u8>)) -> Vec<f64> {
    let mut out = field;
    out.reserve_exact(mask.len());
    out.extend(mask.iter().map(|&m| m as f64));
    out
}

// ============================================================================
// WASM Exports: Phase Unwrapping
// ============================================================================

/// Calculate ROMEO voxel quality map for phase-based masking
///
/// Computes per-voxel quality by averaging ROMEO edge weights across all
/// 6 neighboring directions. Values range from 0 to 100.
///
/// # Arguments
/// * `phase` - Phase data (nx * ny * nz)
/// * `mag` - Magnitude data (nx * ny * nz), can be empty
/// * `phase2` - Second echo phase for gradient coherence (nx * ny * nz), can be empty
/// * `te1`, `te2` - Echo times for gradient coherence scaling
/// * `mask` - Binary mask (nx * ny * nz)
/// * `nx`, `ny`, `nz` - Array dimensions
///
/// # Returns
/// Quality map (nx * ny * nz) with values in range [0, 100]
#[wasm_bindgen]
pub fn voxel_quality_romeo_wasm(
    phase: &[f64],
    mag: &[f64],
    phase2: &[f64],
    te1: f64,
    te2: f64,
    mask: &[u8],
    nx: usize,
    ny: usize,
    nz: usize,
) -> Result<Vec<f64>, JsValue> {
    let n = n_elements(&[nx, ny, nz])?;
    check_len("phase", phase, n)?;
    check_len_or_empty("mag", mag, n)?;
    check_len_or_empty("phase2", phase2, n)?;
    check_len("mask", mask, n)?;

    console_log!("WASM voxel_quality_romeo: {}x{}x{}", nx, ny, nz);

    let phase2_opt = if phase2.is_empty() {
        None
    } else {
        Some(phase2)
    };

    let grid = qsm_core::Grid::new(nx, ny, nz, 1.0, 1.0, 1.0);
    let quality =
        qsm_core::unwrap::romeo::voxel_quality_romeo(phase, mag, phase2_opt, te1, te2, mask, &grid);

    console_log!("WASM voxel quality map complete");
    Ok(quality)
}

// ============================================================================
// WASM Exports: TGV (Single-Step QSM from Wrapped Phase)
// ============================================================================

/// TGV-QSM (Total Generalized Variation) single-step reconstruction
///
/// Reconstructs susceptibility directly from wrapped phase data using TGV
/// regularization. This bypasses phase unwrapping and background field removal.
///
/// # Arguments
/// * `phase` - Wrapped phase data in radians (nx * ny * nz)
/// * `mask` - Binary mask (nx * ny * nz)
/// * `nx`, `ny`, `nz` - Array dimensions
/// * `vsx`, `vsy`, `vsz` - Voxel sizes in mm
/// * `bx`, `by`, `bz` - B0 field direction
/// * `alpha0` - TGV second-order weight (symmetric gradient term)
/// * `alpha1` - TGV first-order weight (gradient term)
/// * `iterations` - Number of primal-dual iterations
/// * `erosions` - Number of mask erosions (default 3)
/// * `te` - Echo time in seconds
/// * `fieldstrength` - Magnetic field strength in Tesla
///
/// # Returns
/// Susceptibility map as Float64Array (ppm)
#[wasm_bindgen]
pub fn tgv_qsm_wasm_with_progress(
    phase: &[f64],
    mask: &[u8],
    nx: usize,
    ny: usize,
    nz: usize,
    vsx: f64,
    vsy: f64,
    vsz: f64,
    bx: f64,
    by: f64,
    bz: f64,
    alpha0: f64,
    alpha1: f64,
    iterations: usize,
    erosions: usize,
    te: f64,
    fieldstrength: f64,
    progress_callback: &js_sys::Function,
) -> Result<Vec<f64>, JsValue> {
    let n = n_elements(&[nx, ny, nz])?;
    check_len("phase", phase, n)?;
    check_len("mask", mask, n)?;

    console_log!(
        "WASM TGV-QSM with progress: {}x{}x{}, iter={}",
        nx,
        ny,
        nz,
        iterations
    );

    let params = qsm_core::inversion::tgv::TgvParams {
        alpha0: alpha0 as f32,
        alpha1: alpha1 as f32,
        iterations: Some(iterations),
        erosions,
        step_size: 3.0,
        ..Default::default()
    };

    let grid = qsm_core::Grid::new(nx, ny, nz, vsx, vsy, vsz);
    let input = qsm_core::inversion::tgv::TgvInput::WrappedPhase {
        phase,
        te_s: te,
        b0_t: fieldstrength,
    };
    let chi = qsm_core::inversion::tgv_qsm(
        input,
        mask,
        &grid,
        &params,
        (bx, by, bz),
        js_progress(progress_callback),
    )
    .map_err(js_err)?;

    console_log!("WASM TGV-QSM complete");
    Ok(chi)
}

/// Get default TGV alpha values for a given regularization level (1-4)
/// Returns [alpha0, alpha1]
#[wasm_bindgen]
pub fn tgv_get_default_alpha_wasm(regularization: u8) -> Vec<f64> {
    let (alpha0, alpha1) = qsm_core::inversion::tgv::get_default_alpha(f32::from(regularization));
    vec![alpha0 as f64, alpha1 as f64]
}

/// Get default TGV iteration count based on voxel size and step size.
/// Matches Julia reference: max(1000, 3200 / prod(res)^0.42) / step_size^0.6
#[wasm_bindgen]
pub fn tgv_get_default_iterations_wasm(vsx: f64, vsy: f64, vsz: f64, step_size: f64) -> usize {
    qsm_core::inversion::tgv::get_default_iterations(
        (vsx as f32, vsy as f32, vsz as f32),
        step_size as f32,
    )
}

// ============================================================================
// WASM Exports: Utilities
// ============================================================================

/// Check if WASM module is loaded and working
#[wasm_bindgen]
pub fn health_check_wasm() -> bool {
    console_log!("QSM-WASM module loaded successfully!");
    true
}

/// Get version string
#[wasm_bindgen]
pub fn get_version_wasm() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// The QSM.rs (`qsm-core`) and QSMxT (`qsmxt-engine`) this bundle was built against, as JSON:
/// `{"qsm_rs": {"version", "commit", "repository"}, "qsmxt": {...}}`.
///
/// Read from `Cargo.lock` at build time (see build.rs), so it is what was linked, not a copy of
/// the pins. `version` is the release tag without its `v`; a dependency pinned to a commit
/// rather than a tag reports `git <short commit>`.
#[wasm_bindgen]
pub fn get_dependency_versions_wasm() -> String {
    let dep = |version: &str, commit: &str, repository: &str| serde_json::json!({ "version": version, "commit": commit, "repository": repository });
    serde_json::json!({
        "qsm_rs": dep(
            env!("QSM_CORE_VERSION"),
            env!("QSM_CORE_COMMIT"),
            env!("QSM_CORE_REPOSITORY"),
        ),
        "qsmxt": dep(
            env!("QSMXT_ENGINE_VERSION"),
            env!("QSMXT_ENGINE_COMMIT"),
            env!("QSMXT_ENGINE_REPOSITORY"),
        ),
    })
    .to_string()
}

// ============================================================================
// WASM Exports: NIfTI I/O
// ============================================================================

/// Load a 3D NIfTI file from bytes
///
/// Returns a JS object with: data (Float64Array), dims (array), voxelSize (array), affine (array)
#[wasm_bindgen]
pub fn load_nifti_wasm(bytes: &[u8]) -> Result<js_sys::Object, JsValue> {
    let nifti_data = qsm_core::io::load_nifti(bytes).map_err(js_err)?;

    let result = js_sys::Object::new();

    // Data as Float64Array
    let data = js_sys::Float64Array::from(nifti_data.data.as_slice());
    js_sys::Reflect::set(&result, &"data".into(), &data)?;

    // Dimensions
    let dims = js_sys::Array::new();
    dims.push(&JsValue::from(nifti_data.dims.0 as u32));
    dims.push(&JsValue::from(nifti_data.dims.1 as u32));
    dims.push(&JsValue::from(nifti_data.dims.2 as u32));
    js_sys::Reflect::set(&result, &"dims".into(), &dims)?;

    // Voxel size
    let voxel_size = js_sys::Array::new();
    voxel_size.push(&JsValue::from(nifti_data.voxel_size.0));
    voxel_size.push(&JsValue::from(nifti_data.voxel_size.1));
    voxel_size.push(&JsValue::from(nifti_data.voxel_size.2));
    js_sys::Reflect::set(&result, &"voxelSize".into(), &voxel_size)?;

    // Affine matrix
    let affine = js_sys::Float64Array::from(nifti_data.affine.as_slice());
    js_sys::Reflect::set(&result, &"affine".into(), &affine)?;

    console_log!(
        "WASM load_nifti: {}x{}x{}, voxel=({:.2},{:.2},{:.2})",
        nifti_data.dims.0,
        nifti_data.dims.1,
        nifti_data.dims.2,
        nifti_data.voxel_size.0,
        nifti_data.voxel_size.1,
        nifti_data.voxel_size.2
    );

    Ok(result)
}

/// Save data as NIfTI bytes
///
/// # Arguments
/// * `data` - Volume data as Float64Array (nx * ny * nz)
/// * `nx`, `ny`, `nz` - Dimensions
/// * `vsx`, `vsy`, `vsz` - Voxel sizes in mm
/// * `affine` - 4x4 affine matrix (16 elements, row-major)
///
/// # Returns
/// NIfTI file as Uint8Array
#[wasm_bindgen]
pub fn save_nifti_wasm(
    data: &[f64],
    nx: usize,
    ny: usize,
    nz: usize,
    vsx: f64,
    vsy: f64,
    vsz: f64,
    affine: &[f64],
) -> Result<Vec<u8>, JsValue> {
    if affine.len() != 16 {
        return Err(js_err("Affine matrix must have 16 elements"));
    }

    let mut affine_arr = [0.0f64; 16];
    affine_arr.copy_from_slice(affine);

    let bytes = qsm_core::io::save_nifti(data, (nx, ny, nz), (vsx, vsy, vsz), &affine_arr)
        .map_err(js_err)?;

    console_log!(
        "WASM save_nifti: {}x{}x{}, {} bytes",
        nx,
        ny,
        nz,
        bytes.len()
    );

    Ok(bytes)
}

// ============================================================================
// WASM Exports: Brain Extraction (BET)
// ============================================================================

/// Tell qsm-core that this module's rayon thread pool is up, so deep-learning inference may use
/// it (tract dispatches on rayon's global pool on wasm).
///
/// Call it right after `initThreadPool` resolves, on the same module — each wasm instance has its
/// own flag, and the lazily-loaded DL bundle is a separate instance from the base one. Without it
/// inference stays single-threaded, which is what a page that is not cross-origin isolated needs:
/// there `initThreadPool` never runs and rayon's global pool cannot be built.
///
/// Only the DL bundle has it (the base bundle has no inference); JS calls it optionally.
#[cfg(all(feature = "parallel", feature = "onnx"))]
#[wasm_bindgen]
pub fn set_threads_ready_wasm(ready: bool) {
    qsm_core::models::onnx::set_wasm_threads_available(ready);
}

/// HD-BET deep-learning brain extraction: magnitude → brain mask.
///
/// A mask **generator** (it replaces the mask rather than refining one), so JS runs this and
/// then hands the result to [`apply_mask_ops_wasm`] for any refinements that follow — the same
/// generator-then-refinements split `build_mask_section` makes natively.
///
/// Weights are not bundled: JS fetches `hd-bet.onnx` from the model registry (123 MB,
/// IndexedDB-cached) and passes the bytes, exactly as for the DL inversion models. Only the DL
/// bundle has this; the base bundle has no inference.
///
/// `patch_x/y/z` must be multiples of 32×32×16. **The browser wants 128×128×64**
/// (`HdBetParams::low_memory`, peak ≈1.9 GB): HD-BET's native 192×192×96 peaks at ≈4.5 GB, over
/// wasm32's 4 GB address space. Below roughly 128×128×64, patches that fall wholly inside the
/// brain start being labelled background.
///
/// `tile_step` is the sliding-window stride as a fraction of the patch, in `(0, 1]`. nnU-Net's
/// 0.5 (50 % overlap) is the quality default; larger strides mean fewer patches and a
/// proportionally shorter run, at softer patch seams.
///
/// `progress_callback(done, total)` reports completed sliding-window patches.
#[cfg(feature = "onnx")]
#[wasm_bindgen]
pub fn hd_bet_wasm(
    magnitude: &[f64],
    nx: usize,
    ny: usize,
    nz: usize,
    vsx: f64,
    vsy: f64,
    vsz: f64,
    weights: &[u8],
    patch_x: usize,
    patch_y: usize,
    patch_z: usize,
    tile_step: f64,
    tta: bool,
    progress_callback: &js_sys::Function,
) -> Result<Vec<u8>, JsValue> {
    let n = nx * ny * nz;
    if magnitude.len() != n {
        return Err(js_err(format!(
            "HD-BET: magnitude has {} voxels, expected {n} for {nx}x{ny}x{nz}",
            magnitude.len()
        )));
    }
    console_log!(
        "WASM HD-BET: {}x{}x{} @ {:.2}x{:.2}x{:.2}mm, patch {}x{}x{}, step {:.2}, tta={}",
        nx,
        ny,
        nz,
        vsx,
        vsy,
        vsz,
        patch_x,
        patch_y,
        patch_z,
        tile_step,
        tta
    );

    let grid = qsm_core::Grid::new(nx, ny, nz, vsx, vsy, vsz);
    // qsm-core validates `tile_step` in (0, 1] and the patch divisibility, so a bad value comes
    // back as a readable error rather than a panic.
    let params = qsm_core::bet::HdBetParams {
        inference: qsm_core::bet::HdBetInference::SlidingWindow {
            patch: (patch_x, patch_y, patch_z),
            tile_step,
        },
        mirror_tta: tta,
    };
    qsm_core::bet::hd_bet(
        magnitude,
        &grid,
        weights,
        &params,
        js_progress(progress_callback),
    )
    .map_err(|e| js_err(format!("HD-BET: {e}")))
}

/// RS2-Net deep-learning rodent brain extraction: magnitude → brain mask.
///
/// A mask **generator**, like [`hd_bet_wasm`]: JS runs this, then hands the result to
/// [`apply_mask_ops_wasm`] for any refinements. qsm-core's `bet::rs2_net` does the work (a port of
/// RS2-Net's nnU-Net pipeline). qsmxt-engine's `rs2-net` mask op loads its weights through
/// qsm-core's model cache, which the browser does not have, so it is not run through
/// `apply_mask_ops_wasm`.
///
/// Weights are not bundled: JS fetches `rs2-net.onnx` from the model registry (63 MB,
/// IndexedDB-cached) and passes the bytes. The graph is traced at a fixed 128×96×128 patch
/// (`qsm_core::bet::RS2_NET_PATCH`, peak ≈2.7 GB); RS2-Net's native 128×128×160 would need
/// ≈4.5 GB, over wasm32's 4 GB address space. Only the DL bundle has this.
///
/// `tile_step` is the sliding-window stride as a fraction of the patch, in `(0, 1]`; `tta`
/// turns on 8-fold mirroring. `progress_callback(done, total)` reports network evaluations.
#[cfg(feature = "onnx")]
#[wasm_bindgen]
pub fn rs2_net_wasm(
    magnitude: &[f64],
    nx: usize,
    ny: usize,
    nz: usize,
    vsx: f64,
    vsy: f64,
    vsz: f64,
    weights: &[u8],
    tile_step: f64,
    tta: bool,
    progress_callback: &js_sys::Function,
) -> Result<Vec<u8>, JsValue> {
    console_log!(
        "WASM RS2-Net: {}x{}x{} @ {:.3}x{:.3}x{:.3}mm, patch {:?}, step {:.2}, tta={}",
        nx,
        ny,
        nz,
        vsx,
        vsy,
        vsz,
        qsm_core::bet::RS2_NET_PATCH,
        tile_step,
        tta
    );
    let n = nx * ny * nz;
    if magnitude.len() != n {
        return Err(js_err(format!(
            "RS2-Net: magnitude has {} voxels, expected {n} for {nx}x{ny}x{nz}",
            magnitude.len()
        )));
    }
    let grid = qsm_core::Grid::new(nx, ny, nz, vsx, vsy, vsz);
    let params = qsm_core::bet::Rs2NetParams {
        tile_step,
        mirror_tta: tta,
    };
    qsm_core::bet::rs2_net(
        magnitude,
        &grid,
        weights,
        &params,
        js_progress(progress_callback),
    )
    .map_err(|e| js_err(format!("RS2-Net: {e}")))
}

/// Apply mask operations to an existing mask, through qsm-core's masking pipeline.
///
/// One implementation for every host: this is the same `qsm_core::pipeline::apply_mask_ops` the
/// qsmxt pipeline runs, so a mask refined here step-by-step matches the one the `--mask ...`
/// section we print would produce.
///
/// # Arguments
/// * `mask` - current binary mask (0/1), `nx * ny * nz`
/// * `ops` - comma-separated qsmxt mask ops, e.g. `"erode:2"`, `"fill-holes:0"`, `"signal-erode"`
/// * `input_data` - the image a generator thresholds (the mask input; may be a phase-quality map)
/// * `magnitude` - the magnitude image, used by the ops that need real signal (BET, HD-BET,
///   signal-gated erosion). Pass an empty array when there is none; those ops then error rather
///   than silently gating on `input_data`.
/// * `nx`, `ny`, `nz` - dimensions; `vsx`, `vsy`, `vsz` - voxel sizes in mm
#[wasm_bindgen]
pub fn apply_mask_ops_wasm(
    mask: Vec<u8>,
    ops: &str,
    input_data: &[f64],
    magnitude: &[f64],
    nx: usize,
    ny: usize,
    nz: usize,
    vsx: f64,
    vsy: f64,
    vsz: f64,
) -> Result<Vec<u8>, JsValue> {
    let n = n_elements(&[nx, ny, nz])?;
    check_len("mask", &mask, n)?;
    check_len_or_empty("input_data", input_data, n)?;
    check_len_or_empty("magnitude", magnitude, n)?;

    let parsed: Vec<qsmxt_engine::MaskOp> = ops
        .split(',')
        .map(|o| o.trim())
        .filter(|o| !o.is_empty())
        .map(qsmxt_engine::parse_mask_op)
        .collect::<Result<_, _>>()
        .map_err(js_err)?;
    if parsed.is_empty() {
        return Ok(mask);
    }
    // `to_mask_sections` converts generator + refinements; all_ops() hands them back in order, so
    // this works whether or not the first op happens to be a generator.
    let section = qsmxt_engine::MaskSection {
        input: qsmxt_engine::MaskingInput::Magnitude,
        generator: parsed[0].clone(),
        refinements: parsed[1..].to_vec(),
    };
    // A mask op string carries no BET surface settings, so BET steps get the [bet] defaults.
    let core = qsmxt_engine::to_mask_sections(
        std::slice::from_ref(&section),
        &qsmxt_engine::config::BetConfig::default(),
    );
    let meta = qsmxt_engine::to_scan_metadata(
        (nx, ny, nz),
        (vsx, vsy, vsz),
        &[],
        0.0,
        (0.0, 0.0, 1.0),
        None,
    );
    let magnitude = (!magnitude.is_empty()).then_some(magnitude);
    qsm_core::pipeline::apply_mask_ops(mask, &core[0].all_ops(), input_data, magnitude, &meta)
        .map_err(js_err)
}

/// BET brain extraction (aligned with FSL-BET2)
///
/// # Arguments
/// * `data` - 3D magnitude image (nx * ny * nz)
/// * `nx`, `ny`, `nz` - Dimensions
/// * `vsx`, `vsy`, `vsz` - Voxel sizes in mm
/// * `fractional_intensity` - Intensity threshold (0.0-1.0, smaller = larger brain)
/// * `smoothness_factor` - Smoothness constraint (default 1.0, larger = smoother surface)
/// * `gradient_threshold` - Z-gradient for threshold (-1 to 1, positive = larger brain at bottom)
/// * `iterations` - Number of surface evolution iterations
/// * `subdivisions` - Icosphere subdivision level (4 = 2562 vertices)
///
/// # Returns
/// Binary mask as Uint8Array (1 = brain, 0 = background)
///
/// The progress callback receives (current_iteration, total_iterations).
#[wasm_bindgen]
pub fn bet_wasm_with_progress(
    data: &[f64],
    nx: usize,
    ny: usize,
    nz: usize,
    vsx: f64,
    vsy: f64,
    vsz: f64,
    fractional_intensity: f64,
    smoothness_factor: f64,
    gradient_threshold: f64,
    iterations: usize,
    subdivisions: usize,
    progress_callback: &js_sys::Function,
) -> Result<Vec<u8>, JsValue> {
    let n = n_elements(&[nx, ny, nz])?;
    check_len("data", data, n)?;

    console_log!(
        "WASM BET with progress: {}x{}x{}, fi={:.2}, smooth={:.2}, grad={:.2}, iter={}, subdiv={}",
        nx,
        ny,
        nz,
        fractional_intensity,
        smoothness_factor,
        gradient_threshold,
        iterations,
        subdivisions
    );

    let grid = qsm_core::Grid::new(nx, ny, nz, vsx, vsy, vsz);
    let params = qsm_core::bet::BetParams {
        fractional_intensity,
        smoothness: smoothness_factor,
        gradient_threshold,
        iterations,
        subdivisions,
        voxel_scale: 1.0,
    };
    let mask = qsm_core::bet::run_bet(data, &grid, &params, js_progress(progress_callback));

    let mask_count: usize = mask.iter().map(|&m| m as usize).sum();
    let coverage = 100.0 * mask_count as f64 / mask.len() as f64;
    console_log!(
        "WASM BET complete: {} voxels ({:.1}%)",
        mask_count,
        coverage
    );

    Ok(mask)
}

// ============================================================================
// Bias Correction Functions
// ============================================================================

/// Bias field correction (makehomogeneous)
///
/// Corrects RF receive field inhomogeneities in magnitude images using
/// the boxsegment approach from MriResearchTools.jl.
///
/// # Arguments
/// * `mag` - Magnitude data (nx * ny * nz)
/// * `nx`, `ny`, `nz` - Dimensions
/// * `vsx`, `vsy`, `vsz` - Voxel sizes in mm
/// * `sigma_mm` - Smoothing sigma in mm (will be clamped to 10% of FOV)
/// * `nbox` - Number of boxes per dimension for segmentation
///
/// # Returns
/// Bias-corrected magnitude
#[wasm_bindgen]
pub fn makehomogeneous_wasm(
    mag: &[f64],
    nx: usize,
    ny: usize,
    nz: usize,
    vsx: f64,
    vsy: f64,
    vsz: f64,
    sigma_mm: f64,
    nbox: usize,
) -> Result<Vec<f64>, JsValue> {
    let n = n_elements(&[nx, ny, nz])?;
    check_len("mag", mag, n)?;

    console_log!(
        "WASM makehomogeneous: {}x{}x{}, voxel=[{:.2},{:.2},{:.2}]mm, sigma={:.1}mm, nbox={}",
        nx,
        ny,
        nz,
        vsx,
        vsy,
        vsz,
        sigma_mm,
        nbox
    );

    // Clamp sigma to 10% of minimum FOV dimension
    let fov_min = (nx as f64 * vsx).min(ny as f64 * vsy).min(nz as f64 * vsz);
    let sigma_clamped = sigma_mm.min(fov_min * 0.1);

    if (sigma_clamped - sigma_mm).abs() > 0.1 {
        console_log!(
            "WASM makehomogeneous: sigma clamped from {:.1} to {:.1}mm",
            sigma_mm,
            sigma_clamped
        );
    }

    let grid = qsm_core::Grid::new(nx, ny, nz, vsx, vsy, vsz);
    let result = qsm_core::utils::bias_correction::makehomogeneous(mag, &grid, sigma_clamped, nbox)
        .map_err(js_err)?;

    console_log!("WASM makehomogeneous complete");
    Ok(result)
}

// ============================================================================
// WASM Exports: QSMART Pipeline Functions
// ============================================================================

/// Generate vasculature mask for QSMART
///
/// Uses bottom-hat filtering and Frangi vesselness to detect blood vessels.
///
/// # Arguments
/// * `magnitude` - Average magnitude image (ideally bias-corrected)
/// * `mask` - Binary brain mask
/// * `nx`, `ny`, `nz` - Dimensions
/// * `sphere_radius` - Radius for bottom-hat filter (default 8)
/// * `frangi_scale_min`, `frangi_scale_max` - Frangi scale range (default [0.5, 6])
/// * `frangi_scale_ratio` - Frangi scale step (default 0.5)
/// * `frangi_c` - Frangi C parameter (default 500)
///
/// # Returns
/// Complementary mask (1 = tissue, 0 = vessel)
#[wasm_bindgen]
pub fn vasculature_mask_wasm_with_progress(
    magnitude: &[f64],
    mask: &[u8],
    nx: usize,
    ny: usize,
    nz: usize,
    sphere_radius: i32,
    frangi_scale_min: f64,
    frangi_scale_max: f64,
    frangi_scale_ratio: f64,
    frangi_c: f64,
    progress_callback: &js_sys::Function,
) -> Result<Vec<f64>, JsValue> {
    let n = n_elements(&[nx, ny, nz])?;
    check_len("magnitude", magnitude, n)?;
    check_len("mask", mask, n)?;

    console_log!("WASM vasculature_mask with progress: {}x{}x{}", nx, ny, nz);

    let params = qsm_core::utils::vasculature::VasculatureParams {
        sphere_radius,
        frangi_scale_range: [frangi_scale_min, frangi_scale_max],
        frangi_scale_ratio,
        frangi_c,
    };

    let grid = qsm_core::Grid::new(nx, ny, nz, 1.0, 1.0, 1.0);
    let result = qsm_core::utils::vasculature::generate_vasculature_mask(
        magnitude,
        mask,
        &grid,
        &params,
        js_progress(progress_callback),
    )
    .map_err(js_err)?;

    console_log!("WASM vasculature_mask complete");
    Ok(result)
}

/// SDF (Spatially Dependent Filtering) background field removal for QSMART
///
/// Variable-radius Gaussian filtering where kernel size depends on proximity to boundary.
///
/// # Arguments
/// * `tfs` - Total field shift (weighted by mask if using R_0)
/// * `mask` - Weighted mask (mask * R_0 for reliability weighting)
/// * `vasc_only` - Vasculature mask (1 = tissue, 0 = vessel). Use all-ones for stage 1.
/// * `nx`, `ny`, `nz` - Dimensions
/// * `sigma1` - Primary smoothing sigma (10 for stage1, 8 for stage2)
/// * `sigma2` - Vasculature proximity sigma (0 for stage1, 2 for stage2)
/// * `lower_lim` - Proximity clamping value (default 0.6)
/// * `curv_constant` - Curvature scaling (default 500)
/// * `use_curvature` - Enable curvature-based weighting
///
/// # Returns
/// Local field shift (background removed)
#[wasm_bindgen]
pub fn sdf_wasm_with_progress(
    tfs: &[f64],
    mask: &[f64],
    vasc_only: &[f64],
    nx: usize,
    ny: usize,
    nz: usize,
    sigma1: f64,
    sigma2: f64,
    lower_lim: f64,
    curv_constant: f64,
    use_curvature: bool,
    progress_callback: &js_sys::Function,
) -> Result<Vec<f64>, JsValue> {
    let n = n_elements(&[nx, ny, nz])?;
    check_len("tfs", tfs, n)?;
    check_len("mask", mask, n)?;
    check_len("vasc_only", vasc_only, n)?;

    console_log!("WASM SDF with progress: {}x{}x{}", nx, ny, nz);

    let params = qsm_core::bgremove::sdf::SdfParams {
        sigma1,
        sigma2,
        lower_lim,
        curv_constant,
        use_curvature,
    };

    let grid = qsm_core::Grid::new(nx, ny, nz, 1.0, 1.0, 1.0);
    let result = qsm_core::bgremove::sdf::sdf(
        tfs,
        mask,
        vasc_only,
        &grid,
        &params,
        js_progress(progress_callback),
    );

    console_log!("WASM SDF complete");
    Ok(result)
}

/// QSMART offset adjustment
///
/// Combines two-stage QSM results with offset adjustment for consistency.
///
/// # Arguments
/// * `removed_voxels` - Voxels in stage 1 but not stage 2 (mask*R_0 - vasc_only)
/// * `lfs_sdf` - Local field from stage 1 (in ppm)
/// * `chi_1` - Susceptibility from stage 1 (whole ROI)
/// * `chi_2` - Susceptibility from stage 2 (tissue only)
/// * `nx`, `ny`, `nz` - Dimensions
/// * `vsx`, `vsy`, `vsz` - Voxel sizes in mm
/// * `bx`, `by`, `bz` - B0 field direction
/// * `ppm` - PPM conversion factor
///
/// # Returns
/// Combined and offset-adjusted susceptibility map
#[wasm_bindgen]
pub fn qsmart_adjust_offset_wasm(
    removed_voxels: &[f64],
    lfs_sdf: &[f64],
    chi_1: &[f64],
    chi_2: &[f64],
    nx: usize,
    ny: usize,
    nz: usize,
    vsx: f64,
    vsy: f64,
    vsz: f64,
    bx: f64,
    by: f64,
    bz: f64,
    ppm: f64,
) -> Result<Vec<f64>, JsValue> {
    let n = n_elements(&[nx, ny, nz])?;
    check_len("removed_voxels", removed_voxels, n)?;
    check_len("lfs_sdf", lfs_sdf, n)?;
    check_len("chi_1", chi_1, n)?;
    check_len("chi_2", chi_2, n)?;

    console_log!("WASM QSMART offset adjustment: {}x{}x{}", nx, ny, nz);

    let grid = qsm_core::Grid::new(nx, ny, nz, vsx, vsy, vsz);
    let result = qsm_core::utils::qsmart::adjust_offset(
        removed_voxels,
        lfs_sdf,
        chi_1,
        chi_2,
        &grid,
        (bx, by, bz),
        ppm,
    );

    console_log!("WASM QSMART offset adjustment complete");
    Ok(result)
}

// ============================================================================
// Algorithm Default Parameters
// ============================================================================

// Each get_*_defaults() serializes the matching qsmxt-engine config struct, whose
// Default impl sources its values from qsm-core. qsmxt-engine is the single source of
// truth for the parameter set (field names + defaults); these bindings just hand it to
// JS as JSON. Adding a field there automatically flows through here — no hand-typed list.
macro_rules! config_defaults {
    ($fn_name:ident, $config:ty) => {
        #[wasm_bindgen]
        pub fn $fn_name() -> String {
            serde_json::to_string(&<$config>::default())
                .expect("config serialization is infallible")
        }
    };
}

config_defaults!(get_rts_defaults, qsmxt_engine::config::RtsConfig);
config_defaults!(get_tv_defaults, qsmxt_engine::config::TvConfig);
config_defaults!(get_tkd_defaults, qsmxt_engine::config::TkdConfig);
config_defaults!(get_tgv_defaults, qsmxt_engine::config::TgvConfig);
config_defaults!(get_bet_defaults, qsmxt_engine::config::BetConfig);
config_defaults!(get_vsharp_defaults, qsmxt_engine::config::VsharpConfig);
config_defaults!(get_pdf_defaults, qsmxt_engine::config::PdfConfig);
config_defaults!(get_lbv_defaults, qsmxt_engine::config::LbvConfig);
config_defaults!(get_ismv_defaults, qsmxt_engine::config::IsmvConfig);
config_defaults!(get_swi_defaults, qsmxt_engine::config::SwiConfig);
config_defaults!(get_sharp_defaults, qsmxt_engine::config::SharpConfig);
config_defaults!(get_resharp_defaults, qsmxt_engine::config::ResharpConfig);
config_defaults!(
    get_harperella_defaults,
    qsmxt_engine::config::HarperellaConfig
);
config_defaults!(get_tikhonov_defaults, qsmxt_engine::config::TikhonovConfig);
config_defaults!(get_nltv_defaults, qsmxt_engine::config::NltvConfig);
config_defaults!(get_ndi_defaults, qsmxt_engine::config::NdiConfig);
config_defaults!(get_fansi_defaults, qsmxt_engine::config::FansiConfig);
config_defaults!(get_l1qsm_defaults, qsmxt_engine::config::L1qsmConfig);
config_defaults!(get_whqsm_defaults, qsmxt_engine::config::WhqsmConfig);
config_defaults!(get_hdqsm_defaults, qsmxt_engine::config::HdqsmConfig);
config_defaults!(get_medi_defaults, qsmxt_engine::config::MediConfig);
config_defaults!(get_tfi_defaults, qsmxt_engine::config::TfiConfig);
config_defaults!(get_qsmart_defaults, qsmxt_engine::config::QsmartConfig);
config_defaults!(get_romeo_defaults, qsmxt_engine::config::RomeoConfig);

/// MCPC-3D-S defaults, `{"sigma": [x, y, z]}` in mm. qsmxt-engine folded its MCPC-3D-S section
/// into `[field_mapping]` (`phase_offset_sigma_mm`); this keeps the shape the UI reads.
#[wasm_bindgen]
pub fn get_mcpc3ds_defaults() -> String {
    let sigma = qsmxt_engine::config::FieldMappingConfig::default().phase_offset_sigma_mm;
    serde_json::json!({ "sigma": sigma }).to_string()
}

config_defaults!(
    get_linear_fit_defaults,
    qsmxt_engine::config::LinearFitConfig
);
config_defaults!(get_ilsqr_defaults, qsmxt_engine::config::IlsqrConfig);

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // A panicking call is reported by its message: the page asks for it after the call aborts.
    #[test]
    fn a_panic_is_kept_for_the_page_once() {
        init();
        let _ = take_panic_wasm();
        let caught = std::panic::catch_unwind(|| {
            let v: Vec<u8> = Vec::new();
            v[3]
        });
        assert!(caught.is_err());
        let text = take_panic_wasm().expect("the panic was kept");
        assert!(
            text.starts_with("index out of bounds: the len is 0 but the index is 3 (at "),
            "{text}"
        );
        assert!(text.contains("lib.rs:"), "{text}");
        assert_eq!(take_panic_wasm(), None);
    }

    #[test]
    fn test_version() {
        let version = get_version_wasm();
        assert!(!version.is_empty());
    }

    #[test]
    fn magnitude_only_relaxometry_preserves_hertz_seconds_and_mask() {
        let tes = [0.01, 0.02, 0.03];
        let magnitudes: Vec<f64> = tes
            .iter()
            .map(|te| 100.0 * (-20.0_f64 * te).exp())
            .chain([9.0, 8.0, 7.0])
            .collect();
        let result =
            magnitude_relaxometry(&magnitudes, &[1, 0], &tes, [2, 1, 1], [1.0; 3]).unwrap();
        assert!((result[0] - 20.0).abs() < 0.001, "{} Hz", result[0]);
        assert!((result[2] - 0.05).abs() < 0.00001, "{} seconds", result[2]);
        assert_eq!((result[1], result[3]), (0.0, 0.0));
    }

    #[test]
    fn magnitude_only_relaxometry_refuses_malformed_inputs() {
        let tes = [0.01, 0.02, 0.03];
        assert!(
            magnitude_relaxometry(&[3.0, 2.0], &[1], &tes, [1, 1, 1], [1.0; 3])
                .unwrap_err()
                .contains("magnitude has 2 elements, expected 3")
        );
        for bad in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            assert_eq!(
                magnitude_relaxometry(&[3.0, bad, 1.0], &[0], &tes, [1, 1, 1], [1.0; 3])
                    .unwrap_err(),
                "magnitude contains non-finite values"
            );
        }
    }

    // The versions come from Cargo.lock, so they follow the pins in Cargo.toml without anyone
    // editing a literal. qsmxt-engine is pinned by tag; qsm-core may be patched to a commit.
    #[test]
    fn dependency_versions_follow_the_pins() {
        let v: serde_json::Value = serde_json::from_str(&get_dependency_versions_wasm()).unwrap();
        let manifest = include_str!("../Cargo.toml");
        let pin = manifest
            .lines()
            .find(|l| l.starts_with("qsmxt-engine"))
            .expect("qsmxt-engine is pinned");
        let pinned = |key: &str| {
            pin.split(&format!("{key} = \""))
                .nth(1)
                .and_then(|t| t.split('"').next())
        };
        // A release tag `vX.Y.Z` reports `X.Y.Z`; a commit pin reports `git <short rev>`.
        match (pinned("tag"), pinned("rev")) {
            (Some(tag), _) => {
                assert_eq!(
                    v["qsmxt"]["version"].as_str(),
                    Some(tag.trim_start_matches('v'))
                )
            }
            (None, Some(rev)) => {
                assert_eq!(v["qsmxt"]["commit"].as_str(), Some(rev));
                assert_eq!(
                    v["qsmxt"]["version"].as_str(),
                    Some(format!("git {}", &rev[..7]).as_str())
                );
            }
            (None, None) => panic!("qsmxt-engine is pinned by neither tag nor rev: {pin}"),
        }
        for dep in ["qsm_rs", "qsmxt"] {
            assert_eq!(
                v[dep]["commit"].as_str().map(str::len),
                Some(40),
                "{dep}: {v}"
            );
            assert!(v[dep]["repository"]
                .as_str()
                .unwrap()
                .starts_with("https://github.com/"));
            assert_ne!(v[dep]["version"], "unknown");
        }
    }

    // A stage used to parse its config with `.unwrap_or_default()`, so a config that
    // failed to parse ran qsm-core's default algorithms and parameters instead of the
    // user's — silently, and indistinguishably from a successful run.

    #[test]
    fn parse_pipeline_config_rejects_malformed_toml() {
        let err = parse_pipeline_config("this is not toml {{{").unwrap_err();
        assert!(err.contains("failed to parse"), "unexpected message: {err}");
    }

    #[test]
    fn parse_pipeline_config_rejects_the_error_string_a_failed_serializer_used_to_return() {
        // config_json_to_toml_wasm used to hand back "ERROR: ..." as though it were TOML,
        // and no caller checked for it. It now throws, but the parse must reject it too.
        assert!(parse_pipeline_config("ERROR: bad config").is_err());
    }

    #[test]
    fn parse_pipeline_config_keeps_the_users_algorithm() {
        let toml = "[bg_removal]\nalgorithm = \"pdf\"\n";
        let config = parse_pipeline_config(toml).expect("valid config should parse");
        let default = qsmxt_engine::PipelineConfig::default();

        assert_eq!(config.bg_removal.algorithm, qsmxt_engine::BfAlgorithm::Pdf);
        assert_ne!(
            config.bg_removal.algorithm, default.bg_removal.algorithm,
            "fixture must differ from the default, or it cannot detect a silent fallback",
        );
    }

    // Input lengths are checked before qsm-core indexes them: a mismatch used to panic, and
    // with panic=abort that killed the worker without a message.

    #[test]
    fn len_mismatch_reports_the_input_and_both_sizes() {
        assert!(len_mismatch("mask", 8, 8, false).is_ok());
        let err = len_mismatch("mask", 7, 8, false).unwrap_err();
        assert!(
            err.contains("mask") && err.contains('7') && err.contains('8'),
            "{err}"
        );
    }

    #[test]
    fn len_mismatch_accepts_empty_only_when_optional() {
        assert!(len_mismatch("magnitude", 0, 8, true).is_ok());
        assert!(len_mismatch("magnitude", 0, 8, false).is_err());
        assert!(len_mismatch("magnitude", 3, 8, true).is_err());
    }

    #[test]
    fn field_and_mask_appends_the_mask_as_f64() {
        assert_eq!(
            field_and_mask((vec![0.5, -0.5], vec![1, 0])),
            vec![0.5, -0.5, 1.0, 0.0]
        );
    }

    #[test]
    fn dl_tiling_table_names_registered_field_inversions() {
        for (id, _) in DL_TILING {
            assert!(
                qsm_core::models::find_model(id).is_some(),
                "DL_TILING lists '{id}', which the model registry lacks"
            );
        }
        let json: serde_json::Value = serde_json::from_str(&get_dl_tiling_defaults()).unwrap();
        let ids = |key: &str| -> std::collections::BTreeSet<String> {
            serde_json::from_value(json[key].clone()).unwrap()
        };
        assert_eq!(
            (json["tile_core"].as_u64(), json["tile_halo"].as_u64()),
            (Some(56), Some(4))
        );
        assert_eq!(ids("tileable").len(), 7);
        assert_eq!(
            ids("off_design"),
            ["lpcnn", "modl-qsm", "nextqsm"].map(String::from).into()
        );
        assert_eq!(
            ids("native"),
            ["autoqsm", "qsmgan"].map(String::from).into()
        );
    }

    #[test]
    fn checked_count_rejects_overflow() {
        assert_eq!(checked_count(&[4, 5, 6]), Ok(120));
        assert!(checked_count(&[usize::MAX, 2]).is_err());
    }

    // Unknown codes used to fall back to a default algorithm, so a typo or an unmapped option
    // silently ran something other than what was asked for.

    #[test]
    fn qsm_reference_rejects_unknown_methods() {
        assert!(matches!(
            qsm_reference("mean"),
            Ok(qsm_core::pipeline::QsmReference::Mean)
        ));
        assert!(matches!(
            qsm_reference("none"),
            Ok(qsm_core::pipeline::QsmReference::None)
        ));
        assert!(qsm_reference("median").is_err());
    }

    #[test]
    fn ppm_scale_requires_a_field_strength() {
        assert!((ppm_scale(3.0).unwrap() - 1e6 / (GYROMAGNETIC_RATIO * 3.0)).abs() < 1e-12);
        assert!(ppm_scale(0.0).is_err());
        assert!(ppm_scale(-3.0).is_err());
        assert!(ppm_scale(f64::NAN).is_err());
    }

    #[test]
    fn apply_mask_section_applies_a_valid_section() {
        let mut config = qsmxt_engine::PipelineConfig::default();
        apply_mask_section(&mut config, "magnitude-first,bet:0.4,erode:2").unwrap();
        let section = &config.masking.sections[0];
        assert!(matches!(
            section.generator,
            qsmxt_engine::MaskOp::Bet { .. }
        ));
        assert_eq!(section.refinements.len(), 1);
    }

    // The browser made its mask with this recipe, so exports must describe it even where it
    // equals the general default and the inversion (QSMART) has a default mask of its own.
    #[test]
    fn a_qsmart_export_keeps_the_mask_recipe_the_browser_used() {
        let mut config = qsmxt_engine::PipelineConfig::default();
        config.inversion.algorithm = qsmxt_engine::QsmAlgorithm::Qsmart;
        apply_mask_section(&mut config, "phase-quality,threshold:otsu,dilate:1,fill-holes:0,erode:1").unwrap();
        let command = qsmxt_engine::generate_command(&config);
        assert!(command.contains("--mask-preset robust-threshold"), "{command}");
        let back = qsmxt_engine::PipelineConfig::from_toml(&config.to_toml().unwrap()).unwrap();
        assert_eq!(back.normalised().0.masking.sections, config.masking.sections);
        // Where the mark decides nothing it is not set, so the settings file does not carry it.
        let mut rts = qsmxt_engine::PipelineConfig::default();
        apply_mask_section(&mut rts, "phase-quality,threshold:otsu,dilate:1,fill-holes:0,erode:1").unwrap();
        assert!(!rts.masking.recipe_chosen);
    }

    #[test]
    fn apply_mask_section_rejects_what_it_cannot_parse() {
        let mut config = qsmxt_engine::PipelineConfig::default();
        assert!(apply_mask_section(&mut config, "").is_ok());
        assert!(apply_mask_section(&mut config, "magnitude,not-an-op").is_err());
        assert!(apply_mask_section(&mut config, "not-an-input,bet:0.5").is_err());
        assert!(apply_mask_section(&mut config, "magnitude").is_err());
    }
}

// ============================================================================
// Pipeline Configuration (via qsmxt-engine library)
// ============================================================================

// qsmbly builds its config as a JSON object (its UI→schema adapter) and lets
// qsmxt-engine do all serialization — so command, methods, the downloadable .toml,
// and the pipeline-execution config are one canonical representation produced by the
// library, never a hand-rolled parallel TOML. `mask_section` is the CLI-style mask
// string parsed here (the tagged mask-op enums round-trip cleanly via serde, unlike a
// hand-written TOML serializer).
fn config_from_json(
    config_json: &str,
    mask_section: &str,
) -> Result<qsmxt_engine::PipelineConfig, JsValue> {
    let mut config: qsmxt_engine::PipelineConfig = serde_json::from_str(config_json)
        .map_err(|e| js_err(format!("config JSON is not a valid PipelineConfig: {e}")))?;
    apply_mask_section(&mut config, mask_section).map_err(js_err)?;
    Ok(config)
}

/// Parse the pipeline config a stage runs under.
///
/// This must never fall back to a default. The config carries the user's chosen
/// algorithms and parameters; substituting qsm-core's defaults for it produces a
/// complete, plausible result from a pipeline the user did not ask for.
///
/// Split from `config_from_toml` so it is testable off-wasm — `js_sys` values cannot
/// be constructed on the host target.
fn parse_pipeline_config(config_toml: &str) -> Result<qsmxt_engine::PipelineConfig, String> {
    qsmxt_engine::PipelineConfig::from_toml(config_toml)
        .map_err(|e| format!("pipeline config failed to parse: {e}"))
}

fn config_from_toml(config_toml: &str) -> Result<qsmxt_engine::PipelineConfig, JsValue> {
    parse_pipeline_config(config_toml).map_err(js_err)
}

/// Serialize a config (JSON, plus CLI-style mask string) to canonical TOML —
/// identical to what the qsmxt.rs CLI writes (all algorithms). Throws on failure.
#[wasm_bindgen]
pub fn config_json_to_toml_wasm(config_json: &str, mask_section: &str) -> Result<String, JsValue> {
    config_from_json(config_json, mask_section)?
        .to_toml()
        .map_err(|e| js_err(format!("could not serialize config to TOML: {e}")))
}

/// Like config_json_to_toml_wasm, but prunes inversion/bg_removal to the selected
/// algorithm only (the omitted ones round-trip as defaults). For the downloadable
/// settings file. Throws on failure.
#[wasm_bindgen]
pub fn config_json_to_toml_selected_wasm(
    config_json: &str,
    mask_section: &str,
) -> Result<String, JsValue> {
    config_from_json(config_json, mask_section)?
        .to_toml_selected()
        .map_err(|e| js_err(format!("could not serialize config to TOML: {e}")))
}

/// Generate a qsmxt CLI command from a config (JSON + mask string). Throws on failure.
#[wasm_bindgen]
pub fn generate_command_wasm(config_json: &str, mask_section: &str) -> Result<String, JsValue> {
    Ok(qsmxt_engine::generate_command(&config_from_json(
        config_json,
        mask_section,
    )?))
}

/// Generate a methods section with citations from a config (JSON + mask string).
/// `tool` should be "qsmxt.rs" or "QSMbly" to credit the correct tool.
/// Returns markdown text. Throws on failure.
#[wasm_bindgen]
pub fn generate_methods_wasm(
    config_json: &str,
    tool: &str,
    mask_section: &str,
) -> Result<String, JsValue> {
    let config = config_from_json(config_json, mask_section)?;
    Ok(qsmxt_engine::methods::generate_methods_for(&config, tool))
}

/// Parse a CLI-style mask string ("input,gen,refine,...") into the config's mask
/// sections, so command and methods both reflect the real mask. The TOML can't
/// easily carry the tagged mask-op enums, so the UI passes the same string the CLI
/// uses and we parse it here with qsmxt-engine's parsers. Empty string = no change.
///
/// Anything it can't parse is an error: leaving the default mask in place would print a
/// command and methods text describing a mask the user didn't make.
fn apply_mask_section(
    config: &mut qsmxt_engine::PipelineConfig,
    mask_section: &str,
) -> Result<(), String> {
    let parts: Vec<&str> = mask_section
        .split(',')
        .map(|p| p.trim())
        .filter(|p| !p.is_empty())
        .collect();
    if parts.is_empty() {
        return Ok(());
    }
    // Need an input plus at least one (generator) op.
    if parts.len() < 2 {
        return Err(format!(
            "mask section '{mask_section}' has an input but no mask operation"
        ));
    }
    let input = qsmxt_engine::parse_masking_input(parts[0])
        .ok_or_else(|| format!("unknown mask input '{}'", parts[0]))?;
    let mut ops = parts[1..]
        .iter()
        .map(|p| qsmxt_engine::parse_mask_op(p).map_err(|e| format!("mask operation '{p}': {e}")))
        .collect::<Result<Vec<_>, _>>()?;
    let generator = ops.remove(0);
    config.masking.sections = vec![qsmxt_engine::MaskSection {
        input,
        generator,
        refinements: ops,
    }];
    // The browser made its mask with this recipe, so it is chosen: without the mark the engine
    // swaps the general default for the inversion's own (QSMART's BET) in command and methods.
    // Keep the mark only where normalising does, so other runs' settings files do not carry it.
    config.masking.recipe_chosen = true;
    config.masking.recipe_chosen = config.normalised().0.masking.recipe_chosen;
    Ok(())
}

/// Return the default PipelineConfig as a JSON string. Throws on failure.
#[wasm_bindgen]
pub fn get_default_config_json_wasm() -> Result<String, JsValue> {
    qsmxt_engine::PipelineConfig::default()
        .to_json()
        .map_err(|e| {
            js_err(format!(
                "could not serialize the default config to JSON: {e}"
            ))
        })
}

/// Validate a TOML config string. Returns empty string on success, error message on failure.
#[wasm_bindgen]
pub fn validate_config_wasm(toml_string: &str) -> String {
    match qsmxt_engine::PipelineConfig::from_toml(toml_string) {
        Err(e) => format!("Parse error: {}", e),
        Ok(_) => String::new(),
    }
}

// =========================================================================
// Shared pipeline stage functions (guaranteed identical to qsmxt.rs)
// =========================================================================

/// Run background removal: total field → local field (ppm). `echo_times` (s) and `magnitude` are
/// what a magnitude-weighted method reads (PDF: every echo's magnitude, the echo slowest, at
/// evenly spaced echo times); either may be empty for the others.
///
/// Returns [local_field_ppm, eroded_mask_f64].
#[wasm_bindgen]
pub fn run_bg_removal_wasm(
    field_ppm: &[f64],
    mask: &[u8],
    nx: usize,
    ny: usize,
    nz: usize,
    vsx: f64,
    vsy: f64,
    vsz: f64,
    field_strength: f64,
    echo_times: &[f64],
    magnitude: &[f64],
    config_toml: &str,
    progress_callback: &js_sys::Function,
) -> Result<Vec<f64>, JsValue> {
    let n = n_elements(&[nx, ny, nz])?;
    check_len("field_ppm", field_ppm, n)?;
    check_len("mask", mask, n)?;

    let config = config_from_toml(config_toml)?;
    let (_, bg_config, _, _) = qsmxt_engine::to_pipeline_stages(&config);
    let meta = qsmxt_engine::to_scan_metadata(
        (nx, ny, nz),
        (vsx, vsy, vsz),
        echo_times,
        field_strength,
        (0.0, 0.0, 1.0),
        None,
    );
    let magnitude = (!magnitude.is_empty()).then_some(magnitude);
    let result = qsm_core::pipeline::run_bg_removal(
        field_ppm,
        mask,
        &meta,
        &bg_config,
        magnitude,
        &mut js_progress(progress_callback),
    );

    let r = result.map_err(|e| js_err(format!("background removal failed: {e}")))?;
    Ok(field_and_mask((r.local_field_ppm, r.eroded_mask)))
}

/// Run dipole inversion: local field → susceptibility (ppm).
///
/// Handles MEDI unit conversion internally.
#[wasm_bindgen]
pub fn run_dipole_inversion_wasm(
    local_field_ppm: &[f64],
    mask: &[u8],
    nx: usize,
    ny: usize,
    nz: usize,
    vsx: f64,
    vsy: f64,
    vsz: f64,
    field_strength: f64,
    echo_times: &[f64],
    bx: f64,
    by: f64,
    bz: f64,
    magnitude: &[f64],
    config_toml: &str,
    progress_callback: &js_sys::Function,
) -> Result<Vec<f64>, JsValue> {
    let n = n_elements(&[nx, ny, nz])?;
    check_len("local_field_ppm", local_field_ppm, n)?;
    check_len("mask", mask, n)?;
    check_len_or_empty("magnitude", magnitude, n)?;

    let config = config_from_toml(config_toml)?;
    let (_, _, inv_config, _) = qsmxt_engine::to_pipeline_stages(&config);
    let meta = qsmxt_engine::to_scan_metadata(
        (nx, ny, nz),
        (vsx, vsy, vsz),
        echo_times,
        field_strength,
        (bx, by, bz),
        None,
    );

    let mag_opt: Option<&[f64]> = if magnitude.is_empty() {
        None
    } else {
        Some(magnitude)
    };
    let result = qsm_core::pipeline::run_dipole_inversion(
        local_field_ppm,
        mask,
        &meta,
        &inv_config,
        mag_opt,
        &mut js_progress(progress_callback),
    );

    result.map_err(|e| js_err(format!("dipole inversion failed: {e}")))
}

/// Map a referencing method name to qsm-core's; an unknown name is an error rather than Mean.
fn qsm_reference(method: &str) -> Result<qsm_core::pipeline::QsmReference, String> {
    match method {
        "mean" => Ok(qsm_core::pipeline::QsmReference::Mean),
        "none" => Ok(qsm_core::pipeline::QsmReference::None),
        other => Err(format!(
            "unknown reference method '{other}' (expected 'mean' or 'none')"
        )),
    }
}

/// Apply QSM referencing (`method` is "mean" or "none").
#[wasm_bindgen]
pub fn apply_reference_wasm(chi: &[f64], mask: &[u8], method: &str) -> Result<Vec<f64>, JsValue> {
    check_len("mask", mask, chi.len())?;

    let ref_method = qsm_reference(method).map_err(js_err)?;
    Ok(qsm_core::pipeline::apply_reference(chi, mask, ref_method))
}

/// Scale phase data to [-pi, pi] range in-place and return the result.
#[wasm_bindgen]
pub fn scale_phase_to_pi_wasm(mut phase: Vec<f64>) -> Vec<f64> {
    qsm_core::pipeline::scale_phase_to_pi(&mut phase);
    phase
}

/// Convert Hz field to ppm given field strength.
#[wasm_bindgen]
pub fn hz_to_ppm_wasm(field_hz: &[f64], field_strength: f64) -> Result<Vec<f64>, JsValue> {
    hz_to_ppm_scale(field_strength)?;
    Ok(qsm_core::pipeline::hz_to_ppm(field_hz, field_strength))
}

/// Convert rad/s field to ppm given field strength.
#[wasm_bindgen]
pub fn rads_to_ppm_wasm(field_rads: &[f64], field_strength: f64) -> Result<Vec<f64>, JsValue> {
    hz_to_ppm_scale(field_strength)?;
    Ok(qsm_core::pipeline::rads_to_ppm(field_rads, field_strength))
}

// ─────────────────────────────────────────────────────────────────────────────
// Chi-separation (susceptibility source separation)
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Magnitude-only relaxometry (the full scan engine requires phase)
// ─────────────────────────────────────────────────────────────────────────────

fn magnitude_relaxometry(
    magnitudes: &[f64],
    mask: &[u8],
    echo_times: &[f64],
    dims: [usize; 3],
    voxel_size: [f64; 3],
) -> Result<Vec<f64>, String> {
    let count = checked_count(&dims)?;
    len_mismatch("mask", mask.len(), count, false)?;
    len_mismatch(
        "magnitude",
        magnitudes.len(),
        checked_count(&[count, echo_times.len()])?,
        false,
    )?;
    if count == 0 || voxel_size.iter().any(|v| !v.is_finite() || *v <= 0.0) {
        return Err("relaxometry requires a nonempty grid with positive voxel sizes".into());
    }
    if magnitudes.iter().any(|v| !v.is_finite()) {
        return Err("magnitude contains non-finite values".into());
    }
    let [nx, ny, nz] = dims;
    let [vx, vy, vz] = voxel_size;
    let grid = qsm_core::Grid::new(nx, ny, nz, vx, vy, vz);
    let (mut r2star, _) = qsm_core::r2star::r2star_arlo(magnitudes, mask, echo_times, &grid)
        .map_err(|e| e.to_string())?;
    let t2star = qsm_core::r2star::t2star_from_r2star(&r2star);
    r2star.extend(t2star);
    Ok(r2star)
}

/// QSMxT's ARLO and T2* conversion on real magnitude-only inputs. Echo times are seconds,
/// magnitudes are voxel-major; the result is `[R2* (1/s); T2* (s)]`, one volume each.
#[wasm_bindgen]
pub fn magnitude_relaxometry_wasm(
    magnitudes: &[f64],
    mask: &[u8],
    echo_times: &[f64],
    nx: usize,
    ny: usize,
    nz: usize,
    vx: f64,
    vy: f64,
    vz: f64,
) -> Result<Vec<f64>, JsValue> {
    magnitude_relaxometry(magnitudes, mask, echo_times, [nx, ny, nz], [vx, vy, vz]).map_err(js_err)
}

// ─────────────────────────────────────────────────────────────────────────────
// Deep-learning model registry (metadata for the JS weight fetcher/cache)
// ─────────────────────────────────────────────────────────────────────────────

/// JSON array describing every registered deep-learning model: `id`, `name`, `stage`,
/// `description`, `paper`, `source`, `license` (the weights' licence or redistribution note),
/// `size_divisor`, `inputs`/`outputs`, and per-file `{name, url, sha256, bytes}`. The JS
/// layer uses this to fetch + cache weights (WASM can't download itself) and to size the
/// download UI.
#[wasm_bindgen]
pub fn get_model_registry_wasm() -> String {
    let arr: Vec<serde_json::Value> = qsm_core::models::all_models()
        .iter()
        .map(|m| {
            let files: Vec<serde_json::Value> = m
                .files
                .iter()
                .map(|f| {
                    serde_json::json!({
                        "name": f.name, "url": f.url, "sha256": f.sha256, "bytes": f.bytes,
                    })
                })
                .collect();
            serde_json::json!({
                "id": m.id, "name": m.name, "stage": format!("{:?}", m.stage),
                "description": m.description, "paper": m.paper, "source": m.source,
                "license": m.license,
                "size_divisor": m.size_divisor, "available": m.is_available(),
                "inputs": m.inputs, "outputs": m.outputs, "files": files,
            })
        })
        .collect();
    serde_json::Value::Array(arr).to_string()
}

/// How browser overlap-tiling applies to a field-input DL inversion.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DlTiling {
    /// Fully convolutional whole-volume net with a tiled variant: approximate but sound.
    Tileable,
    /// Has a tiled variant, but the net takes global (k-space) steps, so tiling is off-design.
    OffDesign,
    /// Already patch-based: it never exhausts memory and ignores the tiling options.
    Native,
}

/// The field-input DL inversions and how tiling applies to each, keyed by model registry id.
/// `run_dl_field_inversion_wasm` runs the `Tileable` and `OffDesign` ids tiled, and JS reads the
/// same table through [`get_dl_tiling_defaults`].
const DL_TILING: &[(&str, DlTiling)] = &[
    ("xqsm", DlTiling::Tileable),
    ("qsmnet", DlTiling::Tileable),
    ("qsmnet-plus", DlTiling::Tileable),
    ("ir2qsm", DlTiling::Tileable),
    ("lpcnn", DlTiling::OffDesign),
    ("modl-qsm", DlTiling::OffDesign),
    ("nextqsm", DlTiling::OffDesign),
    ("qsmgan", DlTiling::Native),
    ("autoqsm", DlTiling::Native),
];

/// Browser default tile: a 64³ patch (core 56 + halo 4 each side), the size the natively
/// patch-based nets use and one that fits the 32-bit heap; a thin halo keeps overlap recompute
/// low. Much smaller than qsm-core's native `TileConfig` default.
const DL_TILE_CORE: usize = 56;
const DL_TILE_HALO: usize = 4;

fn dl_tiling(model_id: &str) -> Option<DlTiling> {
    DL_TILING
        .iter()
        .find(|(id, _)| *id == model_id)
        .map(|&(_, t)| t)
}

/// The DL tiling table as JSON, in model-registry order: `tile_core`/`tile_halo` (the default
/// tile), `tileable` (ids run tiled by default), and the `off_design` and `native` subsets the
/// settings dialog warns about. scripts/generate-defaults.mjs bakes it into qsm-defaults.js so
/// the settings dialog has it before the worker is up.
#[wasm_bindgen]
pub fn get_dl_tiling_defaults() -> String {
    let ids = |keep: fn(DlTiling) -> bool| -> Vec<&'static str> {
        qsm_core::models::all_models()
            .iter()
            .filter(|m| dl_tiling(m.id).is_some_and(keep))
            .map(|m| m.id)
            .collect()
    };
    serde_json::json!({
        "tile_core": DL_TILE_CORE,
        "tile_halo": DL_TILE_HALO,
        "tileable": ids(|t| t != DlTiling::Native),
        "off_design": ids(|t| t == DlTiling::OffDesign),
        "native": ids(|t| t == DlTiling::Native),
    })
    .to_string()
}

// ─────────────────────────────────────────────────────────────────────────────
// Deep-learning inference (ONNX). WASM can't download weights, so JS fetches the
// bytes (see get_model_registry_wasm) and passes them in. Requires the `onnx` feature.
// ─────────────────────────────────────────────────────────────────────────────

/// DL dipole inversion from a **field** → susceptibility (ppm). `model_id` picks the net:
/// xqsm/qsmnet/qsmnet-plus/qsmgan/ir2qsm/lpcnn/modl-qsm take a **local** field; autoqsm and
/// nextqsm take the **total** field (they do their own background removal). `weights2` is only
/// used by nextqsm (its second U-Net); pass an empty slice otherwise.
///
/// `tiled` requests overlap-tiled inference (bounded memory) for the whole-volume nets that
/// otherwise OOM the 32-bit WASM heap on clinical-size data (xqsm, qsmnet, ir2qsm, …). It is an
/// **approximation** — the result matches whole-volume at r≈0.94 but drifts ~30% in low
/// spatial frequencies — so callers should label tiled output as approximate. Models that are
/// already patch-based (qsmgan, autoqsm) ignore the flag; nets with global k-space steps
/// (lpcnn, modl-qsm, nextqsm) can't be tiled and fall back to whole-volume.
#[cfg(feature = "onnx")]
#[wasm_bindgen]
pub fn run_dl_field_inversion_wasm(
    model_id: &str,
    field_ppm: &[f64],
    mask: &[u8],
    nx: usize,
    ny: usize,
    nz: usize,
    vsx: f64,
    vsy: f64,
    vsz: f64,
    bx: f64,
    by: f64,
    bz: f64,
    weights: &[u8],
    weights2: &[u8],
    tiled: bool,
    tile_core: usize,
    tile_halo: usize,
    progress_callback: &js_sys::Function,
) -> Result<Vec<f64>, JsValue> {
    let n = n_elements(&[nx, ny, nz])?;
    check_len("field_ppm", field_ppm, n)?;
    check_len("mask", mask, n)?;

    use qsm_core::inversion as inv;
    let grid = qsm_core::Grid::new(nx, ny, nz, vsx, vsy, vsz);
    let bdir = (bx, by, bz);
    // Per-tile progress → JS (done, total). Non-tiled nets never call it (bar just sits at start).
    let on_tile = js_progress(progress_callback);
    // Caller passes core/halo; a core of 0 means the browser default (see DL_TILE_CORE).
    let cfg = if tile_core > 0 {
        inv::TileConfig {
            core: tile_core,
            halo: tile_halo,
        }
    } else {
        inv::TileConfig {
            core: DL_TILE_CORE,
            halo: DL_TILE_HALO,
        }
    };
    // Tiled variants (bounded WASM memory) for the ids DL_TILING lists as tileable; this match
    // must cover exactly those.
    let has_tiled_variant = matches!(
        dl_tiling(model_id),
        Some(DlTiling::Tileable | DlTiling::OffDesign)
    );
    let tiled_res = if tiled && has_tiled_variant {
        match model_id {
            "xqsm" => Some(inv::xqsm_tiled(
                field_ppm, mask, &grid, weights, &cfg, on_tile,
            )),
            "qsmnet" => Some(inv::qsmnet_tiled(
                field_ppm,
                mask,
                &grid,
                weights,
                &inv::QsmnetNorm::qsmnet(),
                &cfg,
                on_tile,
            )),
            "qsmnet-plus" => Some(inv::qsmnet_tiled(
                field_ppm,
                mask,
                &grid,
                weights,
                &inv::QsmnetNorm::qsmnet_plus(),
                &cfg,
                on_tile,
            )),
            "ir2qsm" => Some(inv::ir2qsm_tiled(
                field_ppm, mask, &grid, weights, &cfg, on_tile,
            )),
            // FFT-unrolled nets: whole-algorithm tiling (off-design, approximate — the UI warns).
            "lpcnn" => Some(inv::lpcnn_tiled(
                field_ppm, mask, &grid, bdir, weights, &cfg, on_tile,
            )),
            "modl-qsm" => Some(inv::modl_qsm_tiled(
                field_ppm, mask, &grid, bdir, weights, &cfg, on_tile,
            )),
            "nextqsm" => Some(inv::nextqsm_tiled(
                field_ppm, mask, &grid, bdir, weights, weights2, &cfg, on_tile,
            )),
            _ => None,
        }
    } else {
        None
    };
    let res = match tiled_res {
        Some(r) => r,
        None => match model_id {
            "xqsm" => inv::xqsm(field_ppm, mask, &grid, weights),
            "qsmnet" => inv::qsmnet(field_ppm, mask, &grid, weights, &inv::QsmnetNorm::qsmnet()),
            "qsmnet-plus" => inv::qsmnet(
                field_ppm,
                mask,
                &grid,
                weights,
                &inv::QsmnetNorm::qsmnet_plus(),
            ),
            "qsmgan" => inv::qsmgan(field_ppm, mask, &grid, weights),
            "ir2qsm" => inv::ir2qsm(field_ppm, mask, &grid, weights),
            "lpcnn" => inv::lpcnn(field_ppm, mask, &grid, bdir, weights),
            "modl-qsm" => inv::modl_qsm(field_ppm, mask, &grid, bdir, weights),
            "autoqsm" => inv::autoqsm(field_ppm, mask, &grid, weights),
            "nextqsm" => inv::nextqsm(field_ppm, mask, &grid, bdir, weights, weights2),
            other => {
                return Err(js_err(format!(
                    "run_dl_field_inversion_wasm: unknown model '{other}'"
                )));
            }
        },
    };
    res.map_err(|e| js_err(format!("{model_id} inference failed: {e}")))
}
