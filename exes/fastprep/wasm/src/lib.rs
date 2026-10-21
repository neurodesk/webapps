//! Browser fastprep: the Rust core driven by a JS host (`createHost` in `packages/fastprep/src/index.js`), which owns files and
//! dispatches each tool step to its worker driver.

use fastprep_core::host::{Exit, Host, Stat, Step};
use fastprep_core::pipeline::{self, Options};
use fastprep_core::run::{Ctx, Templates};
use js_sys::{Array, Promise, Reflect, Uint8Array};
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;

#[wasm_bindgen]
extern "C" {
    pub type JsHost;
    #[wasm_bindgen(method, catch)]
    fn run(
        this: &JsHost,
        argv: Array,
        fsl_out: Option<String>,
        gpu: bool,
    ) -> Result<Promise, JsValue>;
    #[wasm_bindgen(method, catch, js_name = readRange)]
    fn read_range(this: &JsHost, path: &str, offset: f64, len: u32) -> Result<Promise, JsValue>;
    #[wasm_bindgen(method, catch, js_name = readText)]
    fn read_text(this: &JsHost, path: &str, limit: u32) -> Result<Promise, JsValue>;
    #[wasm_bindgen(method, catch)]
    fn write(this: &JsHost, path: &str, bytes: &[u8]) -> Result<Promise, JsValue>;
    #[wasm_bindgen(method, catch)]
    fn append(this: &JsHost, path: &str, bytes: &[u8]) -> Result<Promise, JsValue>;
    #[wasm_bindgen(method)]
    fn exists(this: &JsHost, path: &str) -> bool;
    /// `null` or `[size, mtime]`
    #[wasm_bindgen(method)]
    fn stat(this: &JsHost, path: &str) -> JsValue;
    #[wasm_bindgen(method)]
    fn list(this: &JsHost, dir: &str) -> Array;
    #[wasm_bindgen(method, catch)]
    fn mkdirs(this: &JsHost, dir: &str) -> Result<(), JsValue>;
    #[wasm_bindgen(method)]
    fn remove(this: &JsHost, path: &str);
    #[wasm_bindgen(method, catch)]
    fn rename(this: &JsHost, from: &str, to: &str) -> Result<(), JsValue>;
    #[wasm_bindgen(method, catch)]
    fn copy(this: &JsHost, from: &str, to: &str) -> Result<(), JsValue>;
    #[wasm_bindgen(method)]
    fn now(this: &JsHost) -> f64;
    #[wasm_bindgen(method, js_name = localTime)]
    fn local_time(this: &JsHost) -> String;
    #[wasm_bindgen(method)]
    fn log(this: &JsHost, line: &str);
}

fn message(e: JsValue) -> String {
    e.as_string()
        .or_else(|| {
            Reflect::get(&e, &"message".into())
                .ok()
                .and_then(|m| m.as_string())
        })
        .unwrap_or_else(|| format!("{e:?}"))
}

async fn wait(p: Result<Promise, JsValue>) -> Result<JsValue, String> {
    JsFuture::from(p.map_err(message)?).await.map_err(message)
}

struct Web(JsHost);

impl Host for Web {
    async fn run(&self, step: &Step) -> Result<Exit, String> {
        let argv: Array = step.argv.iter().map(|a| JsValue::from_str(a)).collect();
        let r = wait(self.0.run(argv, step.fsl_out.map(String::from), step.gpu)).await?;
        let field = |k: &str| Reflect::get(&r, &k.into()).unwrap_or(JsValue::UNDEFINED);
        Ok(Exit {
            code: field("code").as_f64().unwrap_or(1.0) as i32,
            stdout: field("stdout").as_string().unwrap_or_default(),
            stderr: field("stderr").as_string().unwrap_or_default(),
        })
    }
    async fn read_range(&self, path: &str, offset: u64, len: usize) -> Result<Vec<u8>, String> {
        Ok(
            Uint8Array::new(&wait(self.0.read_range(path, offset as f64, len as u32)).await?)
                .to_vec(),
        )
    }
    async fn read_text(&self, path: &str, limit: usize) -> Result<String, String> {
        wait(self.0.read_text(path, limit as u32))
            .await?
            .as_string()
            .ok_or_else(|| format!("{path}: not text"))
    }
    async fn write(&self, path: &str, bytes: &[u8]) -> Result<(), String> {
        wait(self.0.write(path, bytes)).await.map(|_| ())
    }
    async fn append(&self, path: &str, bytes: &[u8]) -> Result<(), String> {
        wait(self.0.append(path, bytes)).await.map(|_| ())
    }
    fn exists(&self, path: &str) -> bool {
        self.0.exists(path)
    }
    fn stat(&self, path: &str) -> Option<Stat> {
        let v = self.0.stat(path);
        let a: &Array = v.dyn_ref()?;
        Some((a.get(0).as_f64()? as u64, a.get(1).as_f64()? as u128))
    }
    fn list(&self, dir: &str) -> Vec<String> {
        self.0
            .list(dir)
            .iter()
            .filter_map(|v| v.as_string())
            .collect()
    }
    fn mkdirs(&self, dir: &str) -> Result<(), String> {
        self.0.mkdirs(dir).map_err(message)
    }
    fn remove(&self, path: &str) {
        self.0.remove(path)
    }
    fn rename(&self, from: &str, to: &str) -> Result<(), String> {
        self.0.rename(from, to).map_err(message)
    }
    fn copy(&self, from: &str, to: &str) -> Result<(), String> {
        self.0.copy(from, to).map_err(message)
    }
    fn now(&self) -> f64 {
        self.0.now()
    }
    fn local_time(&self) -> String {
        self.0.local_time()
    }
    fn log(&self, line: &str) {
        self.0.log(line)
    }
}

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
