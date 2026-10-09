//! The BET that QSMbly's browser bundle exports as `bet_wasm_with_progress`, without
//! wasm-bindgen or threads, so Node can instantiate it from bytes. qsm-core's BET has no
//! rayon paths, so a single thread computes the same mask.

#[link(wasm_import_module = "env")]
extern "C" {
    fn progress(current: u32, total: u32);
}

/// Reserves `length` f64 values for the caller to fill with the image.
#[no_mangle]
pub extern "C" fn input(length: usize) -> *mut f64 {
    Box::leak(vec![0.0f64; length].into_boxed_slice()).as_mut_ptr()
}

/// Runs BET on the image at `data` and returns a pointer to its nx * ny * nz mask bytes.
/// Neither buffer is freed: callers use one instance per image.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn bet(
    data: *const f64,
    nx: usize,
    ny: usize,
    nz: usize,
    vsx: f64,
    vsy: f64,
    vsz: f64,
    fractional_intensity: f64,
    smoothness: f64,
    gradient_threshold: f64,
    iterations: usize,
    subdivisions: usize,
) -> *const u8 {
    let image = unsafe { std::slice::from_raw_parts(data, nx * ny * nz) };
    let grid = qsm_core::Grid::new(nx, ny, nz, vsx, vsy, vsz);
    let params = qsm_core::bet::BetParams {
        fractional_intensity,
        smoothness,
        gradient_threshold,
        iterations,
        subdivisions,
    };
    let mask = qsm_core::bet::run_bet(image, &grid, &params, |current, total| unsafe {
        progress(current as u32, total as u32)
    });
    Box::leak(mask.into_boxed_slice()).as_ptr()
}
