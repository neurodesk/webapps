//! Browser glm: `glm --task-analysis` on in-memory files.

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
