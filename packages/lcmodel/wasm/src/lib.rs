//! LCModel for the browser: the Rust port in exes/lcmodel behind a C ABI.
//! A request and its reply are JSON in linear memory:
//!   request  {"control": "...", "files": {"name": "text", ...}, "fdate": "..."}
//!   reply    {"outputs": {"name": "text"}, "stdout": "...", "error": null | "..."}
//! LCModel's inputs (control, .RAW, .H2O, .BASIS) and outputs are all text.

pub mod session;

use std::cell::RefCell;

thread_local!(static REPLY: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) });

#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let mut bytes = Vec::<u8>::with_capacity(len);
    let ptr = bytes.as_mut_ptr();
    std::mem::forget(bytes);
    ptr
}

/// # Safety
/// `ptr`/`len` must come from a matching `alloc`.
#[no_mangle]
pub unsafe extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    drop(Vec::from_raw_parts(ptr, 0, len));
}

#[no_mangle]
pub extern "C" fn reply_ptr() -> *const u8 {
    REPLY.with(|r| r.borrow().as_ptr())
}

#[no_mangle]
pub extern "C" fn reply_len() -> usize {
    REPLY.with(|r| r.borrow().len())
}

fn reply(value: serde_json::Value) {
    REPLY.with(|r| *r.borrow_mut() = value.to_string().into_bytes());
}

/// Run LCModel on the JSON request at `ptr`/`len`; the reply is at
/// `reply_ptr()`/`reply_len()` until the next call.
///
/// # Safety
/// `ptr`/`len` must describe a readable byte range.
#[no_mangle]
pub unsafe extern "C" fn lcmodel_run(ptr: *const u8, len: usize) {
    let bytes = std::slice::from_raw_parts(ptr, len);
    let request: serde_json::Value = match serde_json::from_slice(bytes) {
        Ok(v) => v,
        Err(e) => return reply(serde_json::json!({ "outputs": {}, "stdout": "", "error": format!("bad request: {e}") })),
    };
    let control = request["control"].as_str().unwrap_or("");
    let fdate = request["fdate"].as_str().unwrap_or("");
    let files: Vec<(String, Vec<u8>)> = request["files"]
        .as_object()
        .map(|m| m.iter().map(|(k, v)| (k.clone(), v.as_str().unwrap_or("").as_bytes().to_vec())).collect())
        .unwrap_or_default();
    let refs: Vec<(&str, &[u8])> = files.iter().map(|(k, v)| (k.as_str(), v.as_slice())).collect();
    let result = lcmodel::run_lcmodel(control, &refs, fdate);
    reply(serde_json::json!({ "outputs": result.outputs, "stdout": result.stdout, "error": result.error }));
}

// ---------------------------------------------------------------------------
// FID-A: files are added one by one (the bytes are copied once into wasm
// memory), loaded together (so metabolite and water files pair up), then a
// dataset is preprocessed. Replies are JSON at reply_ptr()/reply_len().
// Progress goes to the imported `env.mrs_progress(text_ptr, text_len, fraction)`.
// ---------------------------------------------------------------------------

#[cfg(target_arch = "wasm32")]
#[link(wasm_import_module = "env")]
extern "C" {
    fn mrs_progress(ptr: *const u8, len: usize, fraction: f32);
}

fn report_progress(text: &str, fraction: f32) {
    #[cfg(target_arch = "wasm32")]
    unsafe {
        mrs_progress(text.as_ptr(), text.len(), fraction)
    };
    #[cfg(not(target_arch = "wasm32"))]
    let _ = (text, fraction);
}

thread_local! {
    static FILES: RefCell<Vec<(String, Vec<u8>)>> = const { RefCell::new(Vec::new()) };
    static DATASETS: RefCell<Vec<session::Dataset>> = const { RefCell::new(Vec::new()) };
    static PROCESSED: RefCell<Option<session::Processed>> = const { RefCell::new(None) };
}

/// Drop added files, loaded datasets and results.
#[no_mangle]
pub extern "C" fn mrs_reset() {
    FILES.with(|f| f.borrow_mut().clear());
    DATASETS.with(|d| d.borrow_mut().clear());
    PROCESSED.with(|p| *p.borrow_mut() = None);
}

/// Take ownership of a buffer from `alloc` as the file `name`.
///
/// # Safety
/// `name_ptr`/`name_len` must be readable UTF-8; `data_ptr`/`data_len` must
/// come from `alloc(data_len)` and are owned by the module afterwards.
#[no_mangle]
pub unsafe extern "C" fn mrs_add_file(name_ptr: *const u8, name_len: usize, data_ptr: *mut u8, data_len: usize) {
    let name = String::from_utf8_lossy(std::slice::from_raw_parts(name_ptr, name_len)).into_owned();
    let bytes = Vec::from_raw_parts(data_ptr, data_len, data_len);
    FILES.with(|f| f.borrow_mut().push((name, bytes)));
}

/// Detect and load the added files, then release them.
#[no_mangle]
pub extern "C" fn mrs_load() {
    load_added_files(&serde_json::json!({}));
}

/// Detect and load with explicit water assignments.
///
/// # Safety
/// `ptr`/`len` must describe a readable JSON byte range.
#[no_mangle]
pub unsafe extern "C" fn mrs_load_with_options(ptr: *const u8, len: usize) {
    match serde_json::from_slice(std::slice::from_raw_parts(ptr, len)) {
        Ok(options) => load_added_files(&options),
        Err(error) => reply(serde_json::json!({"error": format!("Invalid load options: {error}")})),
    }
}

fn load_added_files(options: &serde_json::Value) {
    let files = FILES.with(|f| std::mem::take(&mut *f.borrow_mut()));
    let refs: Vec<(String, &[u8])> = files.iter().map(|(n, b)| (n.clone(), b.as_slice())).collect();
    let (datasets, summary) = session::load_with_options(&refs, options);
    drop(refs);
    drop(files);
    DATASETS.with(|d| *d.borrow_mut() = datasets);
    PROCESSED.with(|p| *p.borrow_mut() = None);
    reply(summary);
}

/// Preprocess one loaded dataset. Request: {"dataset": i, "options": {...}}.
/// Reply: {"report", "spectrum", "unprocessed", "water", "lcmodel"} or {"error"}.
///
/// # Safety
/// `ptr`/`len` must describe a readable byte range.
#[no_mangle]
pub unsafe extern "C" fn mrs_process(ptr: *const u8, len: usize) {
    let req: serde_json::Value = serde_json::from_slice(std::slice::from_raw_parts(ptr, len)).unwrap_or_default();
    let index = req["dataset"].as_u64().unwrap_or(0) as usize;
    let opts = session::Options::from_json(&req["options"]);
    let result = DATASETS.with(|d| {
        let d = d.borrow();
        let ds = d.get(index).ok_or_else(|| "No such dataset; load the files again.".to_string())?;
        session::process(ds, &opts, &mut report_progress, &|| false)
    });
    match result.and_then(|p| session::lcmodel_inputs(&p).map(|inputs| (p, inputs))) {
        Ok((p, inputs)) => {
            let value = serde_json::json!({
                "report": p.report,
                "spectrum": session::spectrum_trace(&p.metab, -0.5, 8.5),
                "unprocessed": session::spectrum_trace(&p.unprocessed, -0.5, 8.5),
                "water": p.water.as_ref().map(|w| session::spectrum_trace(w, -0.5, 8.5)),
                "editOff": p.edit_off.as_ref().map(|s| session::spectrum_trace(s, -0.5, 8.5)),
                "header": session::header(&p.metab),
                "lcmodel": inputs,
            });
            PROCESSED.with(|s| *s.borrow_mut() = Some(p));
            reply(value);
        }
        Err(e) => reply(serde_json::json!({ "error": e })),
    }
}

/// Preprocess one loaded dataset for functional MRS (window/condition binning,
/// transient QC trace, optional BOLD linewidth matching and dynamic export).
/// Request: {"dataset": i, "options": {...}}.
///
/// # Safety
/// `ptr`/`len` must describe a readable byte range.
#[no_mangle]
pub unsafe extern "C" fn mrs_process_fmrs(ptr: *const u8, len: usize) {
    let req: serde_json::Value = match serde_json::from_slice(std::slice::from_raw_parts(ptr, len)) {
        Ok(v) => v,
        Err(e) => return reply(serde_json::json!({ "error": format!("Invalid fMRS request: {e}") })),
    };
    let index = match req["dataset"].as_u64().and_then(|n| usize::try_from(n).ok()) {
        Some(i) => i,
        None => return reply(serde_json::json!({ "error": "Invalid dataset index." })),
    };
    let result = DATASETS.with(|d| {
        let d = d.borrow();
        let ds = d.get(index).ok_or_else(|| "No such dataset; load the files again.".to_string())?;
        session::process_fmrs(ds, &req["options"], &mut report_progress, &|| false)
    });
    match result {
        Ok(value) => reply(value),
        Err(e) => reply(serde_json::json!({ "error": e })),
    }
}
