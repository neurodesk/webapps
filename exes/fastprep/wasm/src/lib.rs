//! Browser fastprep: the Rust core driven by a JS host (`createHost` in `packages/fastprep/src/index.js`), which owns files and
//! dispatches each tool step to its worker driver.

use fastprep_core::host::web::{JsHost, Web};
use fastprep_core::pipeline::{self, Options};
use fastprep_core::run::{Ctx, Templates};
use js_sys::{Array, Reflect};
use wasm_bindgen::prelude::*;

/// Run fastprep over the host's files. `options`: `{bids, out, work, templates, labels, synthsr, frisgo,
/// robustfov, t1w, surfaces, maxBoldBytes, meica, meicaTree, omp, nprocs}`; paths are host paths.
#[wasm_bindgen(js_name = runFastprep)]
pub async fn run_fastprep(host: JsHost, options: JsValue) -> Result<(), JsValue> {
    let get = |k: &str| Reflect::get(&options, &k.into()).unwrap_or(JsValue::UNDEFINED);
    let text = |k: &str, d: &str| get(k).as_string().unwrap_or_else(|| d.to_string());
    let num = |k: &str, d: f64| get(k).as_f64().unwrap_or(d);
    let labels = get("labels")
        .dyn_into::<Array>()
        .map(|a| a.iter().filter_map(|v| v.as_string()).collect())
        .unwrap_or_default();
    let o = Options {
        bids: text("bids", "/bids"),
        labels,
        synthsr: text("synthsr", "all"),
        frisgo: text("frisgo", "runwise"),
        robustfov: get("robustfov").as_bool().unwrap_or(true),
        t1w: get("t1w").as_string(),
        surfaces: get("surfaces").as_bool().unwrap_or(false),
        max_bold_bytes: get("maxBoldBytes").as_f64().map(|b| b as u64),
        meica: text("meica", "auto"),
        meica_tree: text("meicaTree", "tedana_orig"),
    };
    let omp = num("omp", 1.0) as usize;
    let tpl = Templates::new(&text("templates", "/templates"));
    // one GPU slot: the commands match native; drivers pick each tool's browser backend
    let mut ctx = Ctx::new(
        Web(host),
        text("out", "/out"),
        text("work", "/work"),
        tpl,
        omp,
        num("nprocs", omp as f64) as usize,
        1,
    )
    .await;
    ctx.runtime = Some(
        "this browser: WebAssembly, WebGPU where available (MindGrab, SynthSR), one step at a time"
            .into(),
    );
    pipeline::run(&ctx, &o)
        .await
        .map_err(|e| JsValue::from_str(&e))
}
