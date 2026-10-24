// SPDX-License-Identifier: Apache-2.0
//! C ABI for the hmc package (`packages/hmc/src/wasm.js`), as `noddi-wasm` does: no
//! wasm-bindgen. JavaScript reads NIfTI and copies numbers into this module's memory; the module
//! runs the M1 parts of `dwi-hmc` on them. This glue is original code; the functions it calls are
//! the ports in `dwi-hmc` (NiFreeze Apache-2.0, QSIPrep, SciPy, NumPy and scikit-image
//! BSD-3-Clause, transforms3d BSD-2-Clause; see the `LICENSE-*` files in `exes/dwi/hmc`).
//!
//! A transform crosses the boundary as 15 f64: ITK's 12 parameters (the 3×3 matrix row by row,
//! then the translation) and the 3 fixed parameters (the centre), all LPS. A call that fails
//! returns 0 (or 1 for the calls that return a status) and leaves its message in the text buffer
//! (`text_ptr`/`text_len`). Text results (JSON, TSV) go to the same buffer; byte results (a
//! `.mat` file) go to the byte buffer (`bytes_ptr`/`bytes_len`).

use dwi_gradients::B0Rule;
use dwi_hmc::clip::{ClipReport, InputKind, Sample, advanced_clip, advanced_clip_in_place};
use dwi_hmc::gp_model::{DwiSeries, GpModel, clip_prediction};
use dwi_hmc::motion::{Columns, Grid, Motion, motion_tsv, ras_motion_params};
use dwi_hmc::registration::{RegistrationFiles, nifreeze_argv};
use dwi_hmc::{BvecRule, ItkAffine, Matrix4, Precision, rotate_gradients};
use std::cell::RefCell;

thread_local! {
    static TEXT: RefCell<String> = const { RefCell::new(String::new()) };
    static BYTES: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static NIFREEZE: RefCell<Option<NifreezeState>> = const { RefCell::new(None) };
}

struct NifreezeState {
    series: DwiSeries<f32>,
    mask: Vec<bool>,
}

/// Make NiFreeze's diffusion split, median bzero and model mask from one full series.
///
/// # Safety
/// `data` holds nx·ny·nz·n f32, `bvals` n f64, `bvecs` 3·n f64, and `mask` nx·ny·nz u8.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nifreeze_init(
    data: *const f32,
    nx: usize,
    ny: usize,
    nz: usize,
    n: usize,
    bvals: *const f64,
    bvecs: *const f64,
    mask: *const u8,
    gp: u32,
) -> u32 {
    let result = (|| -> Result<NifreezeState, String> {
        if NIFREEZE.with(|state| state.borrow().is_some()) {
            return Err(
                "A NiFreeze model is already active; release it before another run.".into(),
            );
        }
        let nvox = nx
            .checked_mul(ny)
            .and_then(|v| v.checked_mul(nz))
            .ok_or("Invalid NiFreeze grid")?;
        let len = nvox.checked_mul(n).ok_or("Invalid NiFreeze series size")?;
        let (b, v) = unsafe { gradient_table(bvals, bvecs, n) };
        let table = B0Rule::NiFreeze.read(b, v).map_err(|e| e.to_string())?;
        let series = DwiSeries::split(
            unsafe { std::slice::from_raw_parts(data, len) },
            [nx, ny, nz],
            &table,
        )
        .map_err(|e| e.to_string())?;
        let brain: Vec<bool> = unsafe { std::slice::from_raw_parts(mask, nvox) }
            .iter()
            .map(|&v| v != 0)
            .collect();
        let mask = if gp == 1 {
            GpModel::new(&series, Some(&brain))
                .map_err(|e| e.to_string())?
                .data_mask()
                .to_vec()
        } else {
            if series.bzero.is_none() {
                return Err("The trivial model needs at least one b0 volume (b <= 50).".into());
            }
            brain
        };
        Ok(NifreezeState { series, mask })
    })();
    match result {
        Ok(state) => {
            set_text(format!(
                "{{\"dwiVolumes\":{:?},\"b0Volumes\":{:?},\"hasBzero\":{}}}",
                state.series.dwi_volumes,
                state.series.b0_volumes,
                state.series.bzero.is_some()
            ));
            NIFREEZE.with(|slot| *slot.borrow_mut() = Some(state));
            0
        }
        Err(error) => {
            set_text(error);
            1
        }
    }
}

/// Copy the current model's median bzero and registration mask.
///
/// # Safety
/// `bzero` and `mask` have room for nx·ny·nz f64 and u8 respectively.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nifreeze_arrays(bzero: *mut f64, mask: *mut u8) {
    NIFREEZE.with(|slot| {
        let state = slot.borrow();
        let state = state.as_ref().expect("NiFreeze model is not initialized");
        if let Some(values) = &state.series.bzero {
            unsafe { std::ptr::copy_nonoverlapping(values.as_ptr(), bzero, values.len()) };
        }
        for (i, &value) in state.mask.iter().enumerate() {
            unsafe { *mask.add(i) = u8::from(value) };
        }
    });
}

/// Fit and clip one GP leave-one-out target; index counts DWI volumes, not raw frames.
///
/// # Safety
/// `out` has room for nx·ny·nz f64.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn nifreeze_predict(index: usize, out: *mut f64) -> u32 {
    let result = NIFREEZE.with(|slot| {
        let state = slot.borrow();
        let state = state
            .as_ref()
            .ok_or("NiFreeze model is not initialized".to_string())?;
        let model = GpModel::new(&state.series, Some(&state.mask)).map_err(|e| e.to_string())?;
        let mut prediction = model.fit_predict(index).map_err(|e| e.to_string())?;
        clip_prediction(&mut prediction.volume, state.series.shape).map_err(|e| e.to_string())?;
        unsafe {
            std::ptr::copy_nonoverlapping(prediction.volume.as_ptr(), out, prediction.volume.len())
        };
        Ok::<_, String>(format!(
            "{{\"theta\":{:?},\"lml\":{}}}",
            prediction.fit.theta, prediction.fit.lml
        ))
    });
    match result {
        Ok(summary) => {
            set_text(summary);
            0
        }
        Err(error) => {
            set_text(error);
            1
        }
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn nifreeze_release() {
    NIFREEZE.with(|state| *state.borrow_mut() = None);
    // Hosts have copied these results before releasing the model. Keeping their small
    // allocations can split the freed series arena and prevent the next full-size split
    // from fitting under the same heap limit, even though the model itself was dropped.
    TEXT.with(|text| *text.borrow_mut() = String::new());
    BYTES.with(|bytes| *bytes.borrow_mut() = Vec::new());
}

#[unsafe(no_mangle)]
pub extern "C" fn nifreeze_registration_args(seed: u32) {
    let args = nifreeze_argv(
        RegistrationFiles {
            fixed: "fixed.nii",
            moving: "moving.nii",
            mask: "mask.nii",
            output: "out",
        },
        Precision::Float,
        Some(seed),
    );
    set_text(format!(
        "[{}]",
        args.iter()
            .map(|arg| json_string(arg))
            .collect::<Vec<_>>()
            .join(",")
    ));
}

fn set_text(text: String) {
    TEXT.with(|t| *t.borrow_mut() = text);
}

/// Values in one transform: 12 parameters, then 3 fixed parameters.
pub const TRANSFORM_VALUES: usize = 15;

/// Values in one motion row: scale, shear, rotation vector (rad), translation (mm), RAS+.
pub const MOTION_VALUES: usize = 12;

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

#[unsafe(no_mangle)]
pub extern "C" fn text_ptr() -> *const u8 {
    TEXT.with(|t| t.borrow().as_ptr())
}

#[unsafe(no_mangle)]
pub extern "C" fn text_len() -> u32 {
    TEXT.with(|t| t.borrow().len() as u32)
}

#[unsafe(no_mangle)]
pub extern "C" fn bytes_ptr() -> *const u8 {
    BYTES.with(|b| b.borrow().as_ptr())
}

#[unsafe(no_mangle)]
pub extern "C" fn bytes_len() -> u32 {
    BYTES.with(|b| b.borrow().len() as u32)
}

fn transform_from(values: &[f64]) -> ItkAffine {
    ItkAffine {
        precision: Precision::Float,
        parameters: values[..12].try_into().unwrap(),
        fixed: values[12..15].try_into().unwrap(),
    }
}

/// # Safety
/// `values` holds `TRANSFORM_VALUES`·`n` f64.
unsafe fn transforms(values: *const f64, n: usize) -> Vec<ItkAffine> {
    unsafe { std::slice::from_raw_parts(values, TRANSFORM_VALUES * n) }
        .chunks_exact(TRANSFORM_VALUES)
        .map(transform_from)
        .collect()
}

/// # Safety
/// `values` holds 16 f64, row-major.
unsafe fn matrix4(values: *const f64) -> Matrix4 {
    let v = unsafe { std::slice::from_raw_parts(values, 16) };
    std::array::from_fn(|i| std::array::from_fn(|j| v[4 * i + j]))
}

/// # Safety
/// `shape` holds 3 u32 (nx, ny, nz) and `affine` 16 f64.
unsafe fn grid(shape: *const u32, affine: *const f64) -> Grid {
    let s = unsafe { std::slice::from_raw_parts(shape, 3) };
    Grid {
        shape: [s[0] as usize, s[1] as usize, s[2] as usize],
        affine: unsafe { matrix4(affine) },
    }
}

/// # Safety
/// `bvals` holds `n` f64 and `bvecs` 3·`n` (x, y, z for each volume).
unsafe fn gradient_table(
    bvals: *const f64,
    bvecs: *const f64,
    n: usize,
) -> (Vec<f64>, Vec<[f64; 3]>) {
    let b = unsafe { std::slice::from_raw_parts(bvals, n) }.to_vec();
    let v = unsafe { std::slice::from_raw_parts(bvecs, 3 * n) }
        .chunks_exact(3)
        .map(|g| [g[0], g[1], g[2]])
        .collect();
    (b, v)
}

fn json_string(text: &str) -> String {
    let mut out = String::from("\"");
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Reads a `.mat` file into `out` (`TRANSFORM_VALUES` f64). Returns 1 for a float file, 2 for
/// a double file, 0 on error.
///
/// # Safety
/// `bytes` holds `len` bytes and `out` has room for `TRANSFORM_VALUES` f64.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mat_read(bytes: *const u8, len: usize, out: *mut f64) -> u32 {
    let bytes = unsafe { std::slice::from_raw_parts(bytes, len) };
    match ItkAffine::from_mat(bytes) {
        Ok(t) => {
            let out = unsafe { std::slice::from_raw_parts_mut(out, TRANSFORM_VALUES) };
            out[..12].copy_from_slice(&t.parameters);
            out[12..].copy_from_slice(&t.fixed);
            match t.precision {
                Precision::Float => 1,
                Precision::Double => 2,
            }
        }
        Err(e) => {
            set_text(e.to_string());
            0
        }
    }
}

/// Writes the `.mat` bytes of one transform to the byte buffer, in float (`double` 0, as
/// `antsRegistration --float 1` writes) or double precision. Returns the byte count.
///
/// # Safety
/// `values` holds `TRANSFORM_VALUES` f64.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mat_write(values: *const f64, double: u32) -> u32 {
    let mut t = transform_from(unsafe { std::slice::from_raw_parts(values, TRANSFORM_VALUES) });
    if double != 0 {
        t.precision = Precision::Double;
    }
    let bytes = t.to_mat();
    let len = bytes.len() as u32;
    BYTES.with(|b| *b.borrow_mut() = bytes);
    len
}

fn motion_rows(transforms: &[ItkAffine], grid: &Grid) -> Vec<Motion> {
    transforms
        .iter()
        .map(|t| ras_motion_params(t, grid))
        .collect()
}

/// QSIPrep's `get_ras_motion_params` of each transform on the grid `shape` (nx, ny, nz) and
/// `affine` (voxel to RAS): `MOTION_VALUES` f64 per transform into `out`.
///
/// # Safety
/// `transforms` holds `TRANSFORM_VALUES`·`n` f64, `shape` 3 u32, `affine` 16 f64, `out` room
/// for `MOTION_VALUES`·`n` f64.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn motion_params(
    values: *const f64,
    n: usize,
    shape: *const u32,
    affine: *const f64,
    out: *mut f64,
) -> u32 {
    let rows = motion_rows(&unsafe { transforms(values, n) }, &unsafe {
        grid(shape, affine)
    });
    let out = unsafe { std::slice::from_raw_parts_mut(out, MOTION_VALUES * n) };
    for (row, chunk) in rows.iter().zip(out.chunks_exact_mut(MOTION_VALUES)) {
        chunk.copy_from_slice(&row.to_array());
    }
    0
}

/// The motion TSV of one transform per volume (b0 volumes included) to the text buffer:
/// rigid columns (`affine_columns` 0, NiFreeze) or rigid then scale columns (SHORELine).
///
/// # Safety
/// As `motion_params`, without `out`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn motion_table(
    values: *const f64,
    n: usize,
    shape: *const u32,
    affine: *const f64,
    affine_columns: u32,
) -> u32 {
    let rows = motion_rows(&unsafe { transforms(values, n) }, &unsafe {
        grid(shape, affine)
    });
    let columns = if affine_columns != 0 {
        Columns::Affine
    } else {
        Columns::Rigid
    };
    set_text(motion_tsv(&rows, columns));
    0
}

fn bvec_rule(rule: u32, image_affine: Matrix4) -> Result<BvecRule, String> {
    match rule {
        0 => Ok(BvecRule::NiFreeze { image_affine }),
        1 => Ok(BvecRule::ShoreLine),
        other => Err(format!("unknown b-vector rule {other}")),
    }
}

/// Which volumes are b0 under the rule of a method (0 NiFreeze, 1 SHORELine): one byte per
/// volume into `out`. NiFreeze reads the table as float32 first, as `rotate_gradients` does.
///
/// # Safety
/// See `gradient_table`; `out` has room for `n` bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn b0_flags(
    rule: u32,
    bvals: *const f64,
    bvecs: *const f64,
    n: usize,
    out: *mut u8,
) -> u32 {
    let (b, v) = unsafe { gradient_table(bvals, bvecs, n) };
    let ruled = match rule {
        0 => B0Rule::NiFreeze.read(
            b.iter().map(|&x| x as f32 as f64).collect(),
            v.iter().map(|g| g.map(|c| c as f32 as f64)).collect(),
        ),
        1 => B0Rule::QsiPrep.read(b, v),
        other => Err(format!("unknown b-vector rule {other}")),
    };
    match ruled {
        Ok(ruled) => {
            let out = unsafe { std::slice::from_raw_parts_mut(out, n) };
            for (i, flag) in out.iter_mut().enumerate() {
                *flag = ruled.is_b0(i) as u8;
            }
            set_text(String::new());
            0
        }
        Err(e) => {
            set_text(e);
            1
        }
    }
}

/// Rotates the gradient table with one transform per volume by the rule of a method (0
/// NiFreeze with the image's voxel-to-RAS `affine`, 1 SHORELine). Leaves
/// `{"bvec": text, "bval": text, "b0": [0|1, ...]}` in the text buffer.
///
/// # Safety
/// See `gradient_table` and `transforms`; `affine` holds 16 f64.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rotate_table(
    rule: u32,
    bvals: *const f64,
    bvecs: *const f64,
    n: usize,
    values: *const f64,
    affine: *const f64,
) -> u32 {
    let (b, v) = unsafe { gradient_table(bvals, bvecs, n) };
    let xfms = unsafe { transforms(values, n) };
    let result = bvec_rule(rule, unsafe { matrix4(affine) })
        .and_then(|rule| rotate_gradients(&rule, &b, &v, &xfms));
    match result {
        Ok(g) => {
            let flags: Vec<String> = g.b0.iter().map(|&f| (f as u8).to_string()).collect();
            set_text(format!(
                "{{\"bvec\":{},\"bval\":{},\"b0\":[{}]}}",
                json_string(&g.bvec_text()),
                json_string(&g.bval_text()),
                flags.join(",")
            ));
            0
        }
        Err(e) => {
            set_text(e);
            1
        }
    }
}

fn report_json(r: &ClipReport) -> String {
    let input = match r.input {
        InputKind::Float => "float",
        InputKind::Integer => "integer",
    };
    format!(
        "{{\"input\":\"{input}\",\"mutated\":{},\"aMin\":{},\"aMax\":{}}}",
        r.mutated,
        number(r.a_min),
        number(r.a_max)
    )
}

fn number(v: f64) -> String {
    if v.is_finite() {
        format!("{v:?}")
    } else {
        "null".into()
    }
}

/// # Safety
/// `data` addresses `len` values of `T`, suitably aligned.
unsafe fn clip_typed<T: Sample>(
    data: *mut u8,
    len: usize,
    shape: [usize; 3],
) -> Result<ClipReport, String> {
    let values = unsafe { std::slice::from_raw_parts_mut(data as *mut T, len) };
    advanced_clip_in_place(values, shape).map_err(|e| e.to_string())
}

/// # Safety
/// As `clip_typed`, read only.
unsafe fn clip_copy<T: Sample>(
    data: *const u8,
    len: usize,
    shape: [usize; 3],
) -> Result<Vec<i16>, String> {
    let values = unsafe { std::slice::from_raw_parts(data as *const T, len) };
    advanced_clip(values, shape).map_err(|e| e.to_string())
}

fn kind_error(datatype: u32) -> String {
    format!("advanced_clip does not take NIfTI datatype {datatype}")
}

/// NiFreeze's `advanced_clip(data, inplace=True)` on one volume of NIfTI datatype `datatype`
/// (2 uint8, 4 int16, 8 int32, 16 float32, 64 float64, 256 int8, 512 uint16, 768 uint32) and
/// shape `nz, ny, nx` (slowest to fastest). Float data is overwritten with the 0-255 map;
/// integer data is left as it is. Leaves the `ClipReport` as JSON in the text buffer.
///
/// # Safety
/// `data` addresses nz·ny·nx values of that type, aligned for it.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn clip_in_place(
    datatype: u32,
    data: *mut u8,
    nz: usize,
    ny: usize,
    nx: usize,
) -> u32 {
    let shape = [nz, ny, nx];
    let len = nz.saturating_mul(ny).saturating_mul(nx);
    let report = unsafe {
        match datatype {
            2 => clip_typed::<u8>(data, len, shape),
            4 => clip_typed::<i16>(data, len, shape),
            8 => clip_typed::<i32>(data, len, shape),
            16 => clip_typed::<f32>(data, len, shape),
            64 => clip_typed::<f64>(data, len, shape),
            256 => clip_typed::<i8>(data, len, shape),
            512 => clip_typed::<u16>(data, len, shape),
            768 => clip_typed::<u32>(data, len, shape),
            other => Err(kind_error(other)),
        }
    };
    match report {
        Ok(r) => {
            set_text(report_json(&r));
            0
        }
        Err(e) => {
            set_text(e);
            1
        }
    }
}

/// `advanced_clip(data)` (`inplace=False`): the 0-255 map as int16 into `out`, the input
/// unchanged. Arguments as `clip_in_place`.
///
/// # Safety
/// As `clip_in_place`; `out` has room for nz·ny·nx i16.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn clip_copy_i16(
    datatype: u32,
    data: *const u8,
    nz: usize,
    ny: usize,
    nx: usize,
    out: *mut i16,
) -> u32 {
    let shape = [nz, ny, nx];
    let len = nz.saturating_mul(ny).saturating_mul(nx);
    let result = unsafe {
        match datatype {
            2 => clip_copy::<u8>(data, len, shape),
            4 => clip_copy::<i16>(data, len, shape),
            8 => clip_copy::<i32>(data, len, shape),
            16 => clip_copy::<f32>(data, len, shape),
            64 => clip_copy::<f64>(data, len, shape),
            256 => clip_copy::<i8>(data, len, shape),
            512 => clip_copy::<u16>(data, len, shape),
            768 => clip_copy::<u32>(data, len, shape),
            other => Err(kind_error(other)),
        }
    };
    match result {
        Ok(map) => {
            unsafe { std::slice::from_raw_parts_mut(out, len) }.copy_from_slice(&map);
            set_text(String::new());
            0
        }
        Err(e) => {
            set_text(e);
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text() -> String {
        TEXT.with(|t| t.borrow().clone())
    }

    const IDENTITY: [f64; 15] = [
        1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
    ];

    #[test]
    fn mat_round_trip() {
        let mut values = IDENTITY;
        values[9] = -3.0;
        values[10] = 2.0;
        values[11] = 4.0;
        let len = unsafe { mat_write(values.as_ptr(), 0) } as usize;
        let bytes = BYTES.with(|b| b.borrow().clone());
        assert_eq!(bytes.len(), len);
        let mut out = [0.0; TRANSFORM_VALUES];
        assert_eq!(
            unsafe { mat_read(bytes.as_ptr(), len, out.as_mut_ptr()) },
            1
        );
        assert_eq!(out, values);
        assert_eq!(
            unsafe { mat_read(bytes.as_ptr(), len - 1, out.as_mut_ptr()) },
            0
        );
        assert!(text().contains("truncated"), "{}", text());
    }

    #[test]
    fn translation_is_ras_motion() {
        // An LPS translation (−3, 2, 4) is the RAS motion (3, −2, 4) at every pivot.
        let mut values = IDENTITY;
        values[9] = -3.0;
        values[10] = 2.0;
        values[11] = 4.0;
        let shape = [8u32, 8, 8];
        let affine = [
            2.0, 0.0, 0.0, -7.0, 0.0, 2.0, 0.0, -7.0, 0.0, 0.0, 2.0, -7.0, 0.0, 0.0, 0.0, 1.0,
        ];
        let mut out = [0.0; MOTION_VALUES];
        unsafe {
            motion_params(
                values.as_ptr(),
                1,
                shape.as_ptr(),
                affine.as_ptr(),
                out.as_mut_ptr(),
            )
        };
        assert_eq!(&out[9..], &[3.0, -2.0, 4.0]);
        let both = [IDENTITY, values].concat();
        unsafe { motion_table(both.as_ptr(), 2, shape.as_ptr(), affine.as_ptr(), 0) };
        let tsv = text();
        let lines: Vec<&str> = tsv.lines().collect();
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0].split('\t').count(), 7);
        assert!(lines[1].ends_with("\tn/a"), "{tsv}");
        assert!(lines[2].starts_with("3.0\t-2.0\t4.0\t"), "{tsv}");
    }

    #[test]
    fn b0_flags_and_rotation_keep_b0() {
        let bvals = [0.0, 1000.0];
        let bvecs = [0.0, 0.0, 0.0, 1.0, 0.0, 0.0];
        let mut flags = [9u8; 2];
        assert_eq!(
            unsafe { b0_flags(0, bvals.as_ptr(), bvecs.as_ptr(), 2, flags.as_mut_ptr()) },
            0
        );
        assert_eq!(flags, [1, 0]);
        let both = [IDENTITY, IDENTITY].concat();
        let affine = [
            2.0, 0.0, 0.0, 0.0, 0.0, 2.0, 0.0, 0.0, 0.0, 0.0, 2.0, 0.0, 0.0, 0.0, 0.0, 1.0,
        ];
        let status = unsafe {
            rotate_table(
                0,
                bvals.as_ptr(),
                bvecs.as_ptr(),
                2,
                both.as_ptr(),
                affine.as_ptr(),
            )
        };
        assert_eq!(status, 0, "{}", text());
        assert_eq!(
            text(),
            "{\"bvec\":\"0.000000 1.000000\\n0.000000 0.000000\\n0.000000 0.000000\\n\",\"bval\":\"0.00 1000.00\\n\",\"b0\":[1,0]}"
        );
    }

    #[test]
    fn clip_writes_float_and_keeps_integer() {
        let shape = (4, 4, 4);
        let mut float: Vec<f32> = (0..64).map(|i| (i % 7) as f32 * 10.0).collect();
        let before = float.clone();
        let status =
            unsafe { clip_in_place(16, float.as_mut_ptr() as *mut u8, shape.0, shape.1, shape.2) };
        assert_eq!(status, 0, "{}", text());
        assert!(text().contains("\"mutated\":true"), "{}", text());
        assert_ne!(float, before);
        let mut int: Vec<i16> = (0..64).map(|i| (i % 7) as i16 * 10).collect();
        let original = int.clone();
        let status =
            unsafe { clip_in_place(4, int.as_mut_ptr() as *mut u8, shape.0, shape.1, shape.2) };
        assert_eq!(status, 0, "{}", text());
        assert!(text().contains("\"input\":\"integer\",\"mutated\":false"));
        assert_eq!(int, original);
        let mut out = vec![0i16; 64];
        let status =
            unsafe { clip_copy_i16(4, int.as_ptr() as *const u8, 4, 4, 4, out.as_mut_ptr()) };
        assert_eq!(status, 0);
        let expected: Vec<i16> = float.iter().map(|&v| v as i16).collect();
        assert_eq!(out, expected);
        assert_eq!(
            unsafe { clip_in_place(1, int.as_mut_ptr() as *mut u8, 4, 4, 4) },
            1
        );
    }
}
