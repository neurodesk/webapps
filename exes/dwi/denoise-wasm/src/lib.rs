// SPDX-License-Identifier: BSD-3-Clause

//! C ABI for the dwidenoise app. JavaScript holds the volume-major Float32 data in this module's
//! memory, adds the Gram sums of voxel ranges, solves the coefficients of each group and
//! replaces the voxels of each range with their predictions, in place.
//!
//! A range is `count` voxels from `first` of data that holds `volumes` volumes of `stride`
//! voxels. An independent chunk of voxels is `stride = count`, `first = 0`.

use dwi_denoise::{SolveError, accumulate_gram, apply, coefficients_len, gram_len, solve};

#[unsafe(no_mangle)]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let mut bytes = Vec::<u8>::with_capacity(len);
    let ptr = bytes.as_mut_ptr();
    std::mem::forget(bytes);
    ptr
}

/// # Safety
/// `ptr`/`len` must come from a matching `alloc`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    drop(unsafe { Vec::from_raw_parts(ptr, 0, len) });
}

/// Volumes with b below this value (s/mm²) are b0 volumes.
#[unsafe(no_mangle)]
pub extern "C" fn b0_threshold() -> f64 {
    dwi_denoise::B0_THRESHOLD
}

/// The number of f64 values in the Gram matrix of a group of `n` volumes.
#[unsafe(no_mangle)]
pub extern "C" fn gram_length(n: usize) -> usize {
    gram_len(n)
}

/// The number of f64 values in the coefficients of a group of `n` volumes.
#[unsafe(no_mangle)]
pub extern "C" fn coefficients_length(n: usize) -> usize {
    coefficients_len(n)
}

fn group_of(group: *const u32, n: usize, volumes: usize) -> Option<Vec<usize>> {
    if n < 2 {
        return None;
    }
    let g: Vec<usize> = unsafe { std::slice::from_raw_parts(group, n) }
        .iter()
        .map(|&t| t as usize)
        .collect();
    g.iter().all(|&t| t < volumes).then_some(g)
}

fn range_ok(stride: usize, volumes: usize, first: usize, count: usize) -> bool {
    first.checked_add(count).is_some_and(|end| end <= stride)
        && stride.checked_mul(volumes).is_some()
}

/// Adds the Gram sums of voxels `first..first + count` of the `n` volumes listed in `group` to
/// `gram` (`gram_length(n)` f64 values). Returns non-zero for an invalid range or group.
///
/// # Safety
/// `data` must address `stride * volumes` f32 values, `group` `n` u32 values and `gram`
/// `gram_length(n)` f64 values.
#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn gram_accumulate(
    data: *const f32,
    stride: usize,
    volumes: usize,
    first: usize,
    count: usize,
    group: *const u32,
    n: usize,
    gram: *mut f64,
) -> u32 {
    let Some(group) = group_of(group, n, volumes) else {
        return 1;
    };
    if !range_ok(stride, volumes, first, count) {
        return 1;
    }
    let data = unsafe { std::slice::from_raw_parts(data, stride * volumes) };
    let gram = unsafe { std::slice::from_raw_parts_mut(gram, gram_len(n)) };
    accumulate_gram(data, stride, first..first + count, &group, gram);
    0
}

/// Writes the coefficients of a group of `n` volumes from its Gram matrix. Returns 0 on success,
/// -1 when the Gram matrix holds no voxel or `n < 2`, -2 when the data holds NaN or infinity,
/// and `k + 1` when the volume at group position `k` is a linear combination of other volumes
/// of its group.
///
/// # Safety
/// `gram` must address `gram_length(n)` and `coefficients` `coefficients_length(n)` f64 values.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn solve_coefficients(
    gram: *const f64,
    n: usize,
    coefficients: *mut f64,
) -> i32 {
    if n < 2 {
        return -1;
    }
    let gram = unsafe { std::slice::from_raw_parts(gram, gram_len(n)) };
    match solve(gram, n) {
        Ok(c) => {
            unsafe { std::slice::from_raw_parts_mut(coefficients, coefficients_len(n)) }
                .copy_from_slice(&c);
            0
        }
        Err(SolveError::Empty) => -1,
        Err(SolveError::NotFinite) => -2,
        Err(SolveError::Dependent { volume }) => volume as i32 + 1,
    }
}

/// Replaces voxels `first..first + count` of the `n` volumes in `group` with their predictions,
/// in place. Returns non-zero for an invalid range or group.
///
/// # Safety
/// As for `gram_accumulate`, with `coefficients` addressing `coefficients_length(n)` values.
#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn apply_coefficients(
    data: *mut f32,
    stride: usize,
    volumes: usize,
    first: usize,
    count: usize,
    group: *const u32,
    n: usize,
    coefficients: *const f64,
) -> u32 {
    let Some(group) = group_of(group, n, volumes) else {
        return 1;
    };
    if !range_ok(stride, volumes, first, count) {
        return 1;
    }
    let data = unsafe { std::slice::from_raw_parts_mut(data, stride * volumes) };
    let coefficients = unsafe { std::slice::from_raw_parts(coefficients, coefficients_len(n)) };
    apply(data, stride, first..first + count, &group, coefficients);
    0
}
