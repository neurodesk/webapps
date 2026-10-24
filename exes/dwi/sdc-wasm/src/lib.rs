// SPDX-License-Identifier: Apache-2.0 AND BSD-3-Clause
//! Plain C ABI over dwi-sdc. JavaScript owns NIfTI, input buffers and output copies.
use dwi_sdc::{Grid, PhaseEncoding};
use std::cell::RefCell;
thread_local! {
    static RESULT: RefCell<Vec<f32>> = const { RefCell::new(Vec::new()) };
    static COEFFICIENTS: RefCell<Vec<f32>> = const { RefCell::new(Vec::new()) };
    static GRID: RefCell<Vec<f64>> = const { RefCell::new(Vec::new()) };
    static ERROR: RefCell<String> = const { RefCell::new(String::new()) };
}
#[unsafe(no_mangle)]
pub extern "C" fn result_ptr() -> *const f32 {
    RESULT.with(|v| v.borrow().as_ptr())
}
#[unsafe(no_mangle)]
pub extern "C" fn result_len() -> usize {
    RESULT.with(|v| v.borrow().len())
}
#[unsafe(no_mangle)]
pub extern "C" fn coefficients_ptr() -> *const f32 {
    COEFFICIENTS.with(|v| v.borrow().as_ptr())
}
#[unsafe(no_mangle)]
pub extern "C" fn coefficients_len() -> usize {
    COEFFICIENTS.with(|v| v.borrow().len())
}
#[unsafe(no_mangle)]
pub extern "C" fn grid_ptr() -> *const f64 {
    GRID.with(|v| v.borrow().as_ptr())
}
#[unsafe(no_mangle)]
pub extern "C" fn error_ptr() -> *const u8 {
    ERROR.with(|v| v.borrow().as_ptr())
}
#[unsafe(no_mangle)]
pub extern "C" fn error_len() -> usize {
    ERROR.with(|v| v.borrow().len())
}
#[unsafe(no_mangle)]
pub extern "C" fn alloc(bytes: usize) -> *mut u8 {
    let Ok(layout) = std::alloc::Layout::from_size_align(bytes.max(1), 8) else {
        return std::ptr::null_mut();
    };
    unsafe { std::alloc::alloc(layout) }
}
/// # Safety
/// `ptr` was returned by alloc(bytes) and has not been freed.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dealloc(ptr: *mut u8, bytes: usize) {
    if !ptr.is_null() {
        unsafe {
            std::alloc::dealloc(
                ptr,
                std::alloc::Layout::from_size_align(bytes.max(1), 8).unwrap(),
            );
        }
    }
}
unsafe fn geometry(
    nx: usize,
    ny: usize,
    nz: usize,
    affine: *const f64,
) -> Result<Grid, dwi_sdc::Error> {
    let values = unsafe { std::slice::from_raw_parts(affine, 16) };
    Grid::new(
        [nx, ny, nz],
        std::array::from_fn(|i| std::array::from_fn(|j| values[4 * i + j])),
    )
}
fn finish(result: Result<(), dwi_sdc::Error>) -> u32 {
    match result {
        Ok(()) => {
            ERROR.with(|v| v.borrow_mut().clear());
            1
        }
        Err(error) => {
            RESULT.with(|v| v.borrow_mut().clear());
            COEFFICIENTS.with(|v| v.borrow_mut().clear());
            GRID.with(|v| v.borrow_mut().clear());
            ERROR.with(|v| *v.borrow_mut() = error.to_string());
            0
        }
    }
}
/// kind 0 converts LPS displacement to Hz, 1 converts Hz to LPS, and 2 fits the HF B-spline.
/// PE codes are i,i-,j,j-,k,k- in that order. Arrays are x-fastest; vectors interleaved.
/// # Safety
/// `data` holds len readable f32 values and affine holds16 readable f64 values.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn process(
    kind: u32,
    data: *const f32,
    len: usize,
    nx: usize,
    ny: usize,
    nz: usize,
    affine: *const f64,
    readout: f64,
    pe: u32,
) -> u32 {
    finish((|| {
        let image = unsafe { geometry(nx, ny, nz, affine)? };
        if kind == 2 {
            dwi_sdc::validate_wasm_fit(&image)?;
        }
        let values = unsafe { std::slice::from_raw_parts(data, len) };
        let codes = ["i", "i-", "j", "j-", "k", "k-"];
        let encoding = PhaseEncoding::try_from(
            *codes
                .get(pe as usize)
                .ok_or(dwi_sdc::Error("Invalid phase encoding code"))?,
        )?;
        COEFFICIENTS.with(|v| v.borrow_mut().clear());
        GRID.with(|v| v.borrow_mut().clear());
        let out = match kind {
            0 => dwi_sdc::displacement_to_field(values, &image, readout, encoding)?,
            1 => dwi_sdc::field_to_displacement(values, &image, readout, encoding)?,
            2 => {
                let fit = dwi_sdc::approximate(values, &image)?;
                let metadata: Vec<f64> = fit
                    .grid
                    .shape()
                    .into_iter()
                    .map(|v| v as f64)
                    .chain(fit.grid.affine().into_iter().flatten())
                    .collect();
                GRID.with(|v| *v.borrow_mut() = metadata);
                COEFFICIENTS.with(|v| *v.borrow_mut() = fit.coefficients);
                fit.field
            }
            _ => return Err(dwi_sdc::Error("Unknown field-fit operation")),
        };
        RESULT.with(|v| *v.borrow_mut() = out);
        Ok(())
    })())
}
/// # Safety
/// data holds len f32 values; each affine pointer holds16 f64 values.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn evaluate(
    data: *const f32,
    len: usize,
    cx: usize,
    cy: usize,
    cz: usize,
    control_affine: *const f64,
    nx: usize,
    ny: usize,
    nz: usize,
    affine: *const f64,
) -> u32 {
    finish((|| {
        let control = unsafe { geometry(cx, cy, cz, control_affine)? };
        let image = unsafe { geometry(nx, ny, nz, affine)? };
        dwi_sdc::validate_wasm_evaluation(&image, &control)?;
        let values = unsafe { std::slice::from_raw_parts(data, len) };
        let result = dwi_sdc::evaluate(values, &control, &image)?;
        RESULT.with(|v| *v.borrow_mut() = result);
        Ok(())
    })())
}
