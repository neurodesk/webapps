//! Browser SYNcro: the Rust core driven by a JavaScript host (`packages/syncro/src/host.js`), which owns the files
//! and dispatches each tool step to its worker driver.

use js_sys::{Function, Reflect};
use neurodesk_pipeline_host::web::{JsHost, Web};
use syncro_core::pipeline::{self, Device, Normalization, Options};
use wasm_bindgen::prelude::*;

/// Run SYNcro over the host's files and resolve to its provenance as JSON text. `options`: `{input, lesion,
/// pathological, template, out, work, ct, normalization, threads, keepSynth, software}` (host paths); `stage(name)` is
/// called as each stage starts.
#[wasm_bindgen(js_name = runSyncro)]
pub async fn run_syncro(
    host: JsHost,
    options: JsValue,
    stage: Function,
) -> Result<String, JsValue> {
    let get = |k: &str| Reflect::get(&options, &k.into()).unwrap_or(JsValue::UNDEFINED);
    let text = |k: &str| get(k).as_string();
    let required = |k: &str| {
        text(k).ok_or_else(|| JsValue::from_str(&format!("SYNcro option {k} is required")))
    };
    let o = Options {
        input: required("input")?,
        lesion: text("lesion"),
        pathological: text("pathological"),
        template: required("template")?,
        out: text("out").unwrap_or_default(),
        work: text("work").unwrap_or_else(|| "work".into()),
        ct: get("ct").as_bool().unwrap_or(false),
        normalization: match text("normalization").as_deref() {
            None | Some("greedy") => Normalization::Greedy,
            Some("ants") => Normalization::Ants,
            Some(other) => {
                return Err(JsValue::from_str(&format!(
                    "Normalization must be greedy or ants, not {other}."
                )));
            }
        },
        threads: get("threads").as_f64().unwrap_or(1.0) as usize,
        device: Device::Auto,
        keep_synth: get("keepSynth").as_bool().unwrap_or(false),
        heal: false,
        software: js_sys::JSON::stringify(&get("software"))
            .ok()
            .and_then(|t| t.as_string())
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or(serde_json::Value::Null),
    };
    let report = |name: &str| {
        let _ = stage.call1(&JsValue::NULL, &JsValue::from_str(name));
    };
    pipeline::run(&Web(host), &o, &report)
        .await
        .map(|p| p.to_string())
        .map_err(|e| JsValue::from_str(&e))
}
