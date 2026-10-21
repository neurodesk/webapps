//! Browser glm: `glm --task-analysis` and `glm --meica-qc` on in-memory files.

use wasm_bindgen::prelude::*;

/// `[summary_json, lgr, rgl, l, r]`: the JSON summary and four `.nii.gz` t maps, as the CLI writes them.
#[wasm_bindgen]
pub fn task_analysis(
    bold: &[u8],
    sidecar: &str,
    confounds: &str,
    events: &str,
    fwhm: f64,
) -> Result<js_sys::Array, JsValue> {
    let (maps, summary) = glm_core::io::task_analysis(bold, sidecar, confounds, events, fwhm)
        .map_err(|e| JsValue::from_str(&e))?;
    let out = js_sys::Array::new();
    out.push(&JsValue::from_str(&summary));
    for m in maps {
        out.push(&js_sys::Uint8Array::from(&glm_core::io::gzip(&m)[..]));
    }
    Ok(out)
}

/// `glm --meica-qc`: ME-ICA components against the task design and motion (JSON). `events` empty: no task.
#[wasm_bindgen]
pub fn meica_qc(
    mixing: &str,
    metrics: &str,
    confounds: &str,
    events: &str,
    sidecar: &str,
) -> Result<String, JsValue> {
    let events = (!events.is_empty()).then_some(events);
    glm_core::io::meica_qc(mixing, metrics, confounds, events, sidecar)
        .map_err(|e| JsValue::from_str(&e))
}
