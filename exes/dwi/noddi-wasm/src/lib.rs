//! C ABI for the noddi app. JavaScript reads NIfTI, copies Float32 volumes into this module's
//! memory, and reads the maps back. Each call that fails returns non-zero and leaves a message
//! that `text_ptr`/`text_len` expose; `describe` leaves its JSON there.

use dwi_gradients::Gradients;
use dwi_tensor::{Design, fit_volume};
use std::cell::RefCell;

thread_local!(static TEXT: RefCell<String> = const { RefCell::new(String::new()) });

fn set_text(text: String) {
    TEXT.with(|t| *t.borrow_mut() = text);
}

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

/// # Safety
/// `bvals` holds `n` f64 values and `bvecs` holds 3·`n` (x, y, z for each volume).
unsafe fn gradients(bvals: *const f64, bvecs: *const f64, n: usize) -> Result<Gradients, String> {
    let bvals = unsafe { std::slice::from_raw_parts(bvals, n) }.to_vec();
    let bvecs = unsafe { std::slice::from_raw_parts(bvecs, 3 * n) }
        .chunks_exact(3)
        .map(|g| [g[0], g[1], g[2]])
        .collect();
    Gradients::new(bvals, bvecs)
}

fn json_numbers<T: std::fmt::Display>(values: &[T]) -> String {
    let items: Vec<String> = values.iter().map(|v| v.to_string()).collect();
    format!("[{}]", items.join(","))
}

fn json_string(text: &str) -> String {
    let mut out = String::from("\"");
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Summarises a gradient table as JSON: b0 volumes, shells and their counts, the tensor-fit
/// volumes, and why NODDI or the tensor fit cannot run (null when they can).
pub fn describe_json(g: &Gradients) -> String {
    let dti = g.dti_volumes();
    format!(
        "{{\"volumes\":{},\"b0\":{},\"shells\":{},\"shellCounts\":{},\"dtiVolumes\":{},\"dtiError\":{},\"noddiError\":{}}}",
        g.len(),
        json_numbers(&g.b0_volumes()),
        json_numbers(&g.shells()),
        json_numbers(&g.shell_counts()),
        dti.as_ref().map_or("[]".into(), |v| json_numbers(v)),
        dti.as_ref().err().map_or("null".into(), |e| json_string(e)),
        g.check_noddi()
            .err()
            .map_or("null".into(), |e| json_string(&e)),
    )
}

/// # Safety
/// See `gradients`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn describe(bvals: *const f64, bvecs: *const f64, n: usize) -> u32 {
    match unsafe { gradients(bvals, bvecs, n) } {
        Ok(g) => {
            set_text(describe_json(&g));
            0
        }
        Err(e) => {
            set_text(e);
            1
        }
    }
}

/// Number of Float32 values `dti_fit` writes per voxel: FA, MD, AD, RD, S0, then V1 x, y, z.
pub const DTI_OUTPUTS: usize = 8;

/// Fits the tensor to the b0 volumes and the shells up to b = 1200 s/mm² (else the lowest shell). `data` is volume-major
/// (`data[volume * voxels + voxel]`, `volumes` volumes); `mask` is null or one byte per voxel;
/// `out` receives `DTI_OUTPUTS` maps of `voxels` values each, one map after the other.
///
/// # Safety
/// Every pointer must address the number of elements stated above.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dti_fit(
    data: *const f32,
    voxels: usize,
    volumes: usize,
    bvals: *const f64,
    bvecs: *const f64,
    mask: *const u8,
    weighted: u32,
    out: *mut f32,
) -> u32 {
    let g = match unsafe { gradients(bvals, bvecs, volumes) } {
        Ok(g) => g,
        Err(e) => {
            set_text(e);
            return 1;
        }
    };
    let selected = match g.dti_volumes() {
        Ok(v) => v,
        Err(e) => {
            set_text(e);
            return 1;
        }
    };
    let data = unsafe { std::slice::from_raw_parts(data, voxels * volumes) };
    let mask = (!mask.is_null()).then(|| unsafe { std::slice::from_raw_parts(mask, voxels) });
    let design = Design::new(&g.subset(&selected));
    let maps = fit_volume(data, voxels, &selected, &design, mask, weighted != 0);
    let out = unsafe { std::slice::from_raw_parts_mut(out, DTI_OUTPUTS * voxels) };
    for (i, map) in [&maps.fa, &maps.md, &maps.ad, &maps.rd, &maps.s0]
        .into_iter()
        .enumerate()
    {
        out[i * voxels..(i + 1) * voxels].copy_from_slice(map);
    }
    for voxel in 0..voxels {
        for c in 0..3 {
            out[(5 + c) * voxels + voxel] = maps.v1[voxel * 3 + c];
        }
    }
    set_text(String::new());
    0
}

/// Number of Float32 values `noddi_fit` writes per voxel: ICVF, ISOVF, OD, then the fibre
/// direction x, y, z.
pub const NODDI_OUTPUTS: usize = 6;

/// Builds the AMICO dictionary for a gradient table. Returns null, with a message, when NODDI
/// cannot run on it. Free it with `noddi_free`.
///
/// # Safety
/// See `gradients`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn noddi_new(
    bvals: *const f64,
    bvecs: *const f64,
    n: usize,
) -> *mut dwi_amico::Dictionary {
    let made = unsafe { gradients(bvals, bvecs, n) }
        .and_then(|g| g.check_noddi().map(|_| g))
        .and_then(|_| {
            let b = unsafe { std::slice::from_raw_parts(bvals, n) };
            let v: Vec<[f64; 3]> = unsafe { std::slice::from_raw_parts(bvecs, 3 * n) }
                .chunks_exact(3)
                .map(|g| [g[0], g[1], g[2]])
                .collect();
            dwi_amico::Dictionary::new(b, &v)
        });
    match made {
        Ok(d) => Box::into_raw(Box::new(d)),
        Err(e) => {
            set_text(e);
            std::ptr::null_mut()
        }
    }
}

/// # Safety
/// `dict` must come from `noddi_new` and not be freed already.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn noddi_free(dict: *mut dwi_amico::Dictionary) {
    if !dict.is_null() {
        drop(unsafe { Box::from_raw(dict) });
    }
}

/// Fits NODDI to `voxels` voxels. `data` is volume-major (`data[volume * voxels + voxel]`) with
/// the dictionary's volume count; `mask` is null or one byte per voxel; `out` receives
/// `NODDI_OUTPUTS` maps of `voxels` values each. JavaScript calls this on chunks of the image.
///
/// # Safety
/// Every pointer must address the number of elements stated above.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn noddi_fit(
    dict: *const dwi_amico::Dictionary,
    data: *const f32,
    voxels: usize,
    mask: *const u8,
    out: *mut f32,
) -> u32 {
    let dict = unsafe { &*dict };
    let volumes = dict.volumes();
    let data = unsafe { std::slice::from_raw_parts(data, voxels * volumes) };
    let mask = (!mask.is_null()).then(|| unsafe { std::slice::from_raw_parts(mask, voxels) });
    let out = unsafe { std::slice::from_raw_parts_mut(out, NODDI_OUTPUTS * voxels) };
    out.fill(0.0);
    let mut signal = vec![0.0f64; volumes];
    for voxel in 0..voxels {
        if mask.is_some_and(|m| m[voxel] == 0) {
            continue;
        }
        for (v, s) in signal.iter_mut().enumerate() {
            *s = data[v * voxels + voxel] as f64;
        }
        let (fit, n) = dict.fit_voxel(&signal);
        let values = [fit.icvf, fit.isovf, fit.od, n[0], n[1], n[2]];
        for (k, value) in values.iter().enumerate() {
            out[k * voxels + voxel] = *value as f32;
        }
    }
    set_text(String::new());
    0
}

/// Builds dmipy's nonlinear NODDI model; the AMICO entry points stay unchanged.
/// # Safety
/// See `gradients`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dmipy_new(
    bvals: *const f64,
    bvecs: *const f64,
    n: usize,
) -> *mut dwi_dmipy::Model {
    let made = unsafe { gradients(bvals, bvecs, n) }
        .and_then(|g| g.check_noddi())
        .and_then(|_| {
            let b = unsafe { std::slice::from_raw_parts(bvals, n) };
            let directions: Vec<[f64; 3]> = unsafe { std::slice::from_raw_parts(bvecs, n * 3) }
                .chunks_exact(3)
                .map(|v| [v[0], v[1], v[2]])
                .collect();
            dwi_dmipy::Model::new(b, &directions).map_err(|error| error.to_string())
        });
    match made {
        Ok(model) => Box::into_raw(Box::new(model)),
        Err(error) => {
            set_text(error);
            std::ptr::null_mut()
        }
    }
}

/// # Safety
/// `model` must come from `dmipy_new` and not be freed already.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dmipy_free(model: *mut dwi_dmipy::Model) {
    if !model.is_null() {
        drop(unsafe { Box::from_raw(model) });
    }
}

/// Fits dmipy's maps in the same layout as `noddi_fit`. The success text contains
/// fitted/skipped/nonconverged counts. Voxels with a nonpositive first sample are
/// zero, as in the pinned dmipy reference; numerical failures reject the chunk.
/// # Safety
/// The pointers address the lengths stated by `noddi_fit`, with this model's volume count.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dmipy_fit(
    model: *const dwi_dmipy::Model,
    data: *const f32,
    voxels: usize,
    mask: *const u8,
    out: *mut f32,
) -> u32 {
    let model = unsafe { &*model };
    let volumes = model.volumes();
    let data = unsafe { std::slice::from_raw_parts(data, voxels * volumes) };
    let mask = (!mask.is_null()).then(|| unsafe { std::slice::from_raw_parts(mask, voxels) });
    let out = unsafe { std::slice::from_raw_parts_mut(out, NODDI_OUTPUTS * voxels) };
    out.fill(0.0);
    let mut signal = vec![0.0; volumes];
    let (mut fitted, mut skipped, mut nonconverged) = (0, 0, 0);
    for voxel in 0..voxels {
        if mask.is_some_and(|m| m[voxel] == 0) || data[voxel] <= 0.0 {
            skipped += 1;
            continue;
        }
        for (frame, value) in signal.iter_mut().enumerate() {
            *value = f64::from(data[frame * voxels + voxel]);
        }
        let fit = match model.fit(&signal) {
            Ok(fit) => fit,
            Err(error) => {
                set_text(format!("dmipy voxel {voxel}: {error}"));
                return 1;
            }
        };
        fitted += 1;
        nonconverged += usize::from(!fit.converged);
        let [theta, phi, odi, intra, iso] = fit.parameters;
        let maps = [
            intra,
            iso,
            odi,
            theta.sin() * phi.cos(),
            theta.sin() * phi.sin(),
            theta.cos(),
        ];
        for (index, value) in maps.iter().enumerate() {
            out[index * voxels + voxel] = *value as f32;
        }
    }
    set_text(format!(
        "{{\"fitted\":{fitted},\"skipped\":{skipped},\"nonconverged\":{nonconverged},\"failed\":0}}"
    ));
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn describe_reports_shells_and_refusals() {
        let mut bvals = vec![0.0];
        bvals.extend([1000.0; 6]);
        let bvecs = (0..7).map(|i| [1.0, i as f64, 0.5]).collect();
        let g = Gradients::new(bvals, bvecs).unwrap();
        let json = describe_json(&g);
        assert!(json.contains("\"shells\":[1000]"), "{json}");
        assert!(json.contains("\"dtiVolumes\":[0,1,2,3,4,5,6]"), "{json}");
        assert!(json.contains("\"dtiError\":null"), "{json}");
        assert!(
            json.contains("\"noddiError\":\"NODDI needs two or more"),
            "{json}"
        );
    }
}
